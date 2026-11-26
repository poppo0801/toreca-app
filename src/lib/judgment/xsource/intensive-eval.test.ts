import { describe, expect, it } from "vitest";
import { checkExcludeSemantics, claimClassOf } from "./claim-semantics";
import { escalationReason, verifyRegistration, type Evidence, type JudgeOutput } from "./research-loop";
import { makeAnthropicRegistrationJudge, JUDGE_MAX_FIELDS, JUDGE_SYSTEM } from "./research-ai";
import { FIELD_KEYS, fieldGuide } from "./lottery-fields";

const ev = (id: string, text: string, kind: Evidence["kind"] = "page"): Evidence => ({ id, kind, url: kind === "page" ? "https://shop.example.jp/a" : undefined, fetchedAt: "2026-11-25T00:00:00Z", text, contentHash: "h", observations: [], excerpt: text.slice(0, 200) }) as unknown as Evidence;
const out = (o: Partial<JudgeOutput>): JudgeOutput => ({ decision: "register", fields: {}, rationale: "", unresolvedImpact: "none", monitor: { continue: true, why: "" }, costJpy: 0, ...o });

describe("INTENSIVE_EVALUATION: 全項目の取得", () => {
  it("判断の指示に抽選管理の全項目のキーが入り、上限は全項目を落とさない数", () => {
    for (const k of FIELD_KEYS) expect(JUDGE_SYSTEM).toContain(k);
    expect(fieldGuide()).toContain("purchase_end");
    expect(JUDGE_MAX_FIELDS).toBeGreaterThanOrEqual(FIELD_KEYS.length + 2);
  });
  it("判断の出力の absent（記載なし等）と askHuman を読み取る。値のある項目と重なる absent は無視する", async () => {
    const client = { messages: { create: async () => ({ stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: "tool_use", name: "submit_registration_judgment", input: { decision: "tentative", fields: [{ name: "store", value: "A店", basis: "observed", evidenceId: "p1", quote: "A店" }], absent: [{ name: "result_at", status: "not_announced" }, { name: "store", status: "not_stated" }, { name: "x", status: "bogus" }], askHuman: { needed: true, why: "応募は公式LINEのトークだけで公開情報では確認できない", fields: ["deadline"] }, rationale: "r", unresolvedImpact: "material", monitor: { continue: true, why: "" } } }] }) } } as never;
    const j = makeAnthropicRegistrationJudge(client, { model: "claude-haiku-5-5", strict: false });
    const r = await j({ caseId: "c", evidence: [], lastTurn: null, investigationEnd: "sufficient", protectedFields: {} } as never);
    expect(r?.absent).toEqual({ result_at: "not_announced" });
    expect(r?.askHuman).toEqual({ why: "応募は公式LINEのトークだけで公開情報では確認できない", fields: ["deadline"] });
  });
  it("締切以外の日付の項目も、値の日付が引用に無ければ検証の指摘（任意項目＝本登録は止めない）。期間の省略形の終わりは通す", () => {
    const e = ev("p1", "●お渡し・お支払い期間：12月12日(土)～18日(金) ●当選発表：12月11日(金)");
    const v = verifyRegistration({ output: out({ fields: { result_at: { value: "2026-12-12", basis: "observed", evidenceId: "p1", quote: "当選発表：12月11日(金)" }, purchase_end: { value: "2026-12-18", basis: "observed", evidenceId: "p1", quote: "お渡し・お支払い期間：12月12日(土)～18日(金)" } } }), evidence: [e], protectedFields: {} });
    expect(v.nonBlocking).toContain("value_not_in_quote:result_at");
    expect(v.issues).not.toContain("value_not_in_quote:purchase_end");
    expect(v.blocking).toEqual([]);
  });
});

describe("INTENSIVE_EVALUATION: 評価の基準時刻をAIに渡す（年の推測の誤りの是正）", () => {
  it("判断・調査の入力に基準時刻（日本時間）と年の読み方が入る", async () => {
    const { renderJudgeInput, renderTurnInput, basisLine } = await import("./research-ai");
    expect(basisLine("2026-11-25T15:30:00Z")).toContain("2026-11-26 00:30");
    expect(renderJudgeInput({ caseId: "c", evidence: [], lastTurn: null, investigationEnd: "sufficient", protectedFields: {}, basisAt: "2026-11-20T01:00:00Z" })).toContain("評価の基準時刻（日本時間）: 2026-11-20 10:00");
    expect(renderTurnInput({ caseId: "c", evidence: [], history: [], remaining: { turns: 1, fetches: 1, costJpy: 1, elapsedMs: 1000 }, basisAt: "2026-11-20T01:00:00Z" })).toContain("2026-11-20 10:00");
  });
});

describe("INTENSIVE_EVALUATION: 抽選ではない投稿の除外", () => {
  it("理由の種類 not_lottery を判別し、引用が販売の方式・まとめなら支持、抽選の受付なら矛盾", () => {
    expect(claimClassOf("抽選ではない（先着販売）")).toBe("not_lottery");
    expect(claimClassOf("抽選ではない（まとめ・件数）")).toBe("not_lottery");
    expect(checkExcludeSemantics({ claim: "抽選ではない（先着販売）", quote: "ポケモンセンターオンラインで販売開始⚡ 一人1点まで購入可能！" }).ok).toBe(true);
    expect(checkExcludeSemantics({ claim: "抽選ではない（まとめ・件数）", quote: "全国の受付中の抽選 | 11/20(金)09:00時点 - 60件" }).ok).toBe(true);
    expect(checkExcludeSemantics({ claim: "抽選ではない", quote: "抽選販売のお知らせ 応募期間 11/20〜11/26" }).ok).toBe(false);
  });
  it("「AではなくB」は否定された A で分類しない（受付終了を抽選でないと誤分類しない）", () => {
    expect(claimClassOf("抽選ではない（先着販売）ではなく、抽選応募受付期間が終了している（締切済み）")).toBe("closed");
  });
  it("受付終了の理由の引用に日付が無くても、検証を通った締切の項目の引用で締切が評価時点より前と確かめられれば支持する", () => {
    const now = new Date("2026-11-22T15:15:00Z");
    expect(checkExcludeSemantics({ claim: "受付終了（締切済み）", quote: "抽選応募受け付け期間", now }).ok).toBe(false);
    expect(checkExcludeSemantics({ claim: "受付終了（締切済み）", quote: "抽選応募受け付け期間", now, deadlineQuote: "応募期間 11月6日(金)16時00分~11月10日(火)16時59分まで" }).ok).toBe(true);
    expect(checkExcludeSemantics({ claim: "受付終了", quote: "抽選応募受け付け期間", now, deadlineQuote: "応募期間 11月30日(月)まで" }).ok).toBe(false); // 締切が先なら終了ではない
  });
  it("抽選ではない除外は、応募先のページの証拠が無くても投稿を根拠にできる（他の理由は従来どおりページが必要）", () => {
    const seed = ev("s1", "【ポケカ販売情報】ポケモンセンターオンラインで販売開始⚡ 一人1点まで購入可能！", "seed");
    const ok = verifyRegistration({ output: out({ decision: "exclude", fields: { exclude_reason: { value: "抽選ではない（先着販売）", basis: "observed", evidenceId: "s1", quote: "販売開始⚡ 一人1点まで購入可能！" } } }), evidence: [seed], protectedFields: {}, registerRequiresUnit: true });
    expect(ok.issues).not.toContain("exclude_without_page_evidence");
    const ng = verifyRegistration({ output: out({ decision: "exclude", fields: { exclude_reason: { value: "受付終了", basis: "observed", evidenceId: "s1", quote: "販売開始⚡ 一人1点まで購入可能！" } } }), evidence: [seed], protectedFields: {}, registerRequiresUnit: true });
    expect(ng.issues).toContain("exclude_without_page_evidence");
  });
});

describe("INTENSIVE_EVALUATION: 上位モデルの費用対効果", () => {
  const pages = [ev("p1", "本文")];
  it("重大な不明が、人が確かめれば分かること（askHuman）だけなら上位を使わない", () => {
    expect(escalationReason({ output: out({ decision: "tentative", unresolvedImpact: "material" }), verified: true, evidence: pages, caseId: "a", auditRate: 0 })).toBe("material_unknown");
    expect(escalationReason({ output: out({ decision: "tentative", unresolvedImpact: "material", askHuman: { why: "LINEのトークだけ", fields: [] } }), verified: true, evidence: pages, caseId: "a", auditRate: 0 })).toBeNull();
  });
});
