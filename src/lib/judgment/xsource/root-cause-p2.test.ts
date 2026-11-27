// @vitest-environment node
/**
 * Phase 2 P2 の原因究明（無課金）。**検索ツールの配線**（runXPostReplay → cachedTools → runResearch）を、偽の検索プロバイダーで実際に通して確認する。
 * P2 の実AI試験では、検索ツールが有効（--search）なのに、URLなしの3件で検索が0回だった。コードの調査で、`cachedTools` が `search` を引き継がないことが判明した（本テストで再現・修正を確認する）。
 */
import { describe, expect, it } from "vitest";
import { CallBudget } from "../call-budget";
import { cachedTools, runXPostReplay, type StoredXPost } from "./x-origin";
import type { AgentTurnInput, AgentTurnOutput, FetchOutcome, ResearchAgent, ResearchTools, RegistrationJudge } from "./research-loop";
import { makeSearchTool } from "./research-search";

const NOW = new Date("2026-11-23T00:00:00Z");
const post = (o: Partial<StoredXPost> = {}): StoredXPost => ({ postId: "p1", text: "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111", links: [], recordedAt: NOW.toISOString(), ...o });
const html = (store: string) => `<html><body><h1 class="heading01">【${store}】拡張パック 抽選受付</h1><h2>受付・チケット情報</h2><section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">${store} 拡張パック</h4><p class="event-detail-ticket-card__text">受付</p></section></body></html>`;
const out = (next: AgentTurnOutput["next"]): AgentTurnOutput => ({ observed: [], inferred: [], unknown: [], counterHypotheses: [], next, costJpy: 0.1 });
const judge: RegistrationJudge = async () => ({ decision: "tentative", fields: {}, rationale: "", unresolvedImpact: "minor", monitor: { continue: true, why: "" }, costJpy: 0.1 });

/** 実際の調査AIと同じく、「検索が使える」ときだけ検索を選ぶ代役。agent に届いた searchAvailable を記録する */
const recordingAgent = (seen: AgentTurnInput[]): ResearchAgent => {
  let step = 0;
  return async (i) => {
    seen.push(i);
    step++;
    if (step === 1 && i.searchAvailable) return out({ kind: "search", query: "新宿本店 拡張パック 抽選", why: "応募先を探す" });
    if (step === 2 && i.searchResults?.length) return out({ kind: "fetch", url: i.searchResults[0].url, why: "候補のページを確認" });
    return out({ kind: "stop", reason: i.searchAvailable ? "sufficient" : "unreachable", why: "" });
  };
};
const mkTools = (log: string[], withSearch: boolean): ResearchTools => ({
  now: () => NOW,
  ...(withSearch ? { search: makeSearchTool({ search: async (q: string) => (log.push(`search:${q}`), [{ title: "新宿本店", url: "https://shop-a.example.invalid/e/1", snippet: "拡張パック 抽選受付" }]) }) } : {}),
  fetchPage: async (u: string): Promise<FetchOutcome> => (log.push(`fetch:${u}`), u.includes("shop-a") ? { ok: true, finalUrl: u, html: html("新宿本店"), text: "【新宿本店】拡張パック 抽選受付 新宿本店 拡張パック 受付" } : { ok: false, reason: "not_public" }),
});
const limits = { agentReserveJpy: 0.1, judgeReserveJpy: 0.1, searchReserveJpy: 0.5, maxSearches: 1, maxTurns: 4, maxFetches: 3 };
const budget = () => new CallBudget({ maxCalls: 40, maxCostJpy: 50 });

describe("P2 原因: runXPostReplay が検索ツールを調査ループへ渡す（配線）", () => {
  it("【再現・回帰】検索ツールを注入すると、調査AIの入力に searchAvailable=true が届き、検索が実際に1回実行され、見つけたページへ進める", async () => {
    const seen: AgentTurnInput[] = [];
    const log: string[] = [];
    const r = await runXPostReplay({ post: post(), agent: recordingAgent(seen), judge, tools: mkTools(log, true), budget: budget(), limits, now: NOW });
    expect(seen[0].searchAvailable).toBe(true); // P2 では false だった（cachedTools が search を落としていた）
    expect(log.filter((l) => l.startsWith("search:"))).toHaveLength(1);
    expect(log).toContain("fetch:https://shop-a.example.invalid/e/1"); // 検索結果の候補ページを取得
    expect(r.results[0].result.searches).toHaveLength(1);
    expect(r.results[0].result.evidence.some((e) => e.kind === "page")).toBe(true);
  });
  it("検索ツールを注入しない場合は従来どおり OFF（searchAvailable=false・検索は実行されない・到達不能で終了）", async () => {
    const seen: AgentTurnInput[] = [];
    const log: string[] = [];
    const r = await runXPostReplay({ post: post(), agent: recordingAgent(seen), judge, tools: mkTools(log, false), budget: budget(), limits, now: NOW });
    expect(seen[0].searchAvailable).toBe(false);
    expect(log.filter((l) => l.startsWith("search:"))).toHaveLength(0);
    expect(r.results[0].result.investigation.reason).toBe("unreachable");
  });
  it("cachedTools は search を引き継ぐ（同じ検索語は投稿内で1回だけ実行＝有料検索の重複を避ける）。上限・予算は調査ループ側で維持される", async () => {
    const log: string[] = [];
    const c = cachedTools(mkTools(log, true));
    expect(typeof c.search).toBe("function");
    const a = await c.search!("同じ検索語");
    const b = await c.search!("同じ  検索語"); // 表記ゆれ（空白）も同じ検索
    expect(log.filter((l) => l.startsWith("search:"))).toHaveLength(1);
    expect(a.ok && b.ok).toBe(true);
    expect(b.ok && b.costJpy).toBe(0); // 2回目は費用0（キャッシュ）
    expect(cachedTools(mkTools([], false)).search).toBeUndefined(); // 検索なしは undefined のまま
  });
  it("検索の上限（maxSearches）・予算の枯渇は、配線の修正後も守られる。2件目の項目は同じ検索語ならキャッシュ", async () => {
    const seen: AgentTurnInput[] = [];
    const log: string[] = [];
    const two = post({ text: "《新宿本店（東京）- 1件》 ・拡張パック 抽選 https://t.co/aaa111 《新宿本店（東京）- 1件》 ・拡張パック 抽選 https://t.co/bbb222" });
    await runXPostReplay({ post: two, agent: recordingAgent(seen), judge, tools: mkTools(log, true), budget: budget(), limits, now: NOW });
    expect(log.filter((l) => l.startsWith("search:")).length).toBe(1); // 2項目で同じ検索語 → 実行は1回
    // 予算が小さすぎて検索の予約を確保できない場合は、検索を実行しない（調査は止まる）
    const log2: string[] = [];
    await runXPostReplay({ post: post(), agent: recordingAgent([]), judge, tools: mkTools(log2, true), budget: new CallBudget({ maxCalls: 40, maxCostJpy: 0.35 }), limits, now: NOW });
    expect(log2.filter((l) => l.startsWith("search:"))).toHaveLength(0);
  });
});

describe("P2 原因: 応募単位の保存（列挙値の注釈）・未確定の本登録案・判断出力の省略・検索の提示の記録", () => {
  it("列挙の語に注釈が付いた値（P2 の lp/9）は先頭の列挙の語を採用する。列挙の語でなければ unknown のまま（語の推測はしない）", async () => {
    const { unitOf } = await import("./proposal");
    const f = (value: string | null, basis: "observed" | "inferred" | "unknown" = "inferred") => ({ apply_unit: { value, basis, quote: null, evidence: null, support: "no_value" as const } });
    expect(unitOf(f("one_form_one（お一人様１回まで応募可能）"))).toEqual({ unit: "one_form_one", basis: "inferred" }); // P2: unknown に落ちていた
    expect(unitOf(f("store_select"))).toEqual({ unit: "store_select", basis: "inferred" });
    expect(unitOf(f("店舗選択式っぽい"))).toEqual({ unit: "unknown", basis: "unknown" });
    expect(unitOf(f("per_shop"))).toEqual({ unit: "unknown", basis: "unknown" });
    expect(unitOf(f(null, "unknown"))).toEqual({ unit: "unknown", basis: "unknown" });
  });
  it("本登録案（register）なのに応募単位が未確定なら検証の指摘（登録案の経路のみ）。確定・推定があれば指摘しない。暫定は対象外。従来の経路（フラグなし）は変えない", async () => {
    const { verifyRegistration } = await import("./research-loop");
    const ev = [{ id: "s1", kind: "seed", url: null, fetchedAt: "x", contentHash: "h", text: "【A店】拡張パック 抽選 お1人様1回", structure: null, independent: true }] as never;
    const out = (unit: unknown, decision = "register") => ({ decision, fields: { store: { value: "A店", basis: "observed", evidenceId: "s1", quote: "【A店】拡張パック" }, ...(unit === undefined ? {} : { apply_unit: unit }) }, rationale: "", unresolvedImpact: "minor", monitor: { continue: true, why: "" }, costJpy: 0 }) as never;
    const v = (o: never, flag = true) => verifyRegistration({ output: o, evidence: ev, protectedFields: {}, registerRequiresUnit: flag }).issues;
    // AUTONOMY_RESTORATION: 応募単位の形式を本登録の必須条件にしない（未確定は確認事項として示す。登録案は人が確認する）
    expect(v(out({ value: null, basis: "unknown" }))).toEqual([]);
    expect(v(out(undefined))).toEqual([]);
    expect(verifyRegistration({ output: out(undefined), evidence: ev, protectedFields: {}, registerRequiresUnit: true }).unconfirmed.join(" ")).toContain("応募単位が未確定");
    expect(v(out({ value: "one_form_one", basis: "inferred" }))).toEqual(["unit_inferred_without_quote:apply_unit"]); // ADAPTIVE_REVIEW: 本登録案の応募単位の推定には、構造の根拠（証拠と引用）が要る
    expect(v(out({ value: "one_form_one", basis: "inferred", evidenceId: "s1", quote: "【A店】拡張パック 抽選" }))).toEqual([]);
    expect(v(out({ value: "per_store", basis: "observed", evidenceId: "s1", quote: "お1人様1回" }))).toEqual([]);
    expect(v(out({ value: null, basis: "unknown" }, "tentative"))).toEqual([]);
    expect(v(out({ value: null, basis: "unknown" }), false)).toEqual([]); // 従来の経路は変えない
  });
  it("fields が省略された判断は、成功と数えず（未確認事項に記録）、判断の理由を保存し、停止理由に検索の提示/実行を残す", async () => {
    const { toProposalRecords } = await import("./proposal");
    const plan = { itemNo: 1, groupLabel: "", itemText: "x", links: [], scopedUrls: [], status: "short_unexpanded", seedText: "s", linkEvidence: [] } as never;
    const mk = (output: unknown, searchOffered: boolean, searches: { query: string; url: string }[]) => ({ investigation: { reason: "unreachable", turns: 1 }, registration: { decision: "tentative", verified: true, held: null, output }, evidence: [], searches, searchOffered, budget: { costJpy: 0.1 } }) as never;
    const post = { postId: "p", text: "x", links: [], recordedAt: null };
    const base = { decision: "tentative", fields: {}, rationale: "証拠が無いため暫定", unresolvedImpact: "material", monitor: { continue: true, why: "" }, costJpy: 0 };
    const a = toProposalRecords({ candidateId: "c", post, run: { results: [{ plan, result: mk({ ...base, outputNote: "fields_defaulted" }, false, []) }] }, mode: "real", modelId: "m", fetchedAt: null })[0];
    expect(a.unknowns.some((u) => u.what === "AIの判断" && u.why.includes("省略"))).toBe(true);
    expect(a.fields._rationale.value).toBe("証拠が無いため暫定");
    expect(a.stopReason).toBe("unreachable|search_not_offered");
    const b = toProposalRecords({ candidateId: "c", post, run: { results: [{ plan, result: mk(base, true, [{ query: "q", url: "https://a.example.invalid/x" }, { query: "q", url: "https://b.example.invalid/y" }]) }] }, mode: "real", modelId: "m", fetchedAt: null })[0];
    expect(b.stopReason).toBe("unreachable|searched:1"); // 同じ検索語は1回と数える
    expect(toProposalRecords({ candidateId: "c", post, run: { results: [{ plan, result: mk(base, true, []) }] }, mode: "real", modelId: "m", fetchedAt: null })[0].stopReason).toBe("unreachable|searched:0");
  });
  it("判断の指示に応募単位の意味（4種）と、本登録案は応募単位の確定/推定が要ることを明記し、調査の指示は『URLが与えられていれば検索しない』を含む（文面の存在のみ。実AIでの効果は未検証）", async () => {
    const { JUDGE_SYSTEM, RESEARCH_SYSTEM } = await import("./research-ai");
    for (const t of ["one_form_one:", "store_select:", "per_store:", "per_product:", "実際のフォーム上の、応募できる権利の単位", "確定できないなら暫定（tentative）"]) expect(JUDGE_SYSTEM, t).toContain(t);
    expect(RESEARCH_SYSTEM).toContain("検索しない（そのページを取得して確認する）");
    expect(JUDGE_SYSTEM.length).toBeLessThan(9000); // AUTONOMY_RESTORATION で商品の種類・除外の種類・追加の検討の申告（約400字）を追加 →9000（性能優先。指示の長さの削減は利用者の方針で後回し） // EVIDENCE_UTILIZATION で管理の対象の方針・除外/暫定でも全項目（約700字）を追加 →8400 // INTENSIVE_EVALUATION で全項目の定義・記載の状態・人の確認・条件・抽選でない投稿（約2,000字）を追加 →7600 // 入力の増加は小さい（費用への影響は §対照で試算）。Phase 3 基盤立て直しで応募単位と上限の分離（約430字）を追加し、4000→4600、RUNTIME_CORRECTNESS で地域適合・受付時刻の根拠（約350字）を追加し→5200
  });
});

describe("P2 原因: ページ証拠なしの除外（r10:2）は人の確認に回す（登録案の経路のみ）", () => {
  it("応募先のページを取得できないまま exclude は exclude_without_page_evidence。ページ証拠（受付終了のページ等）があれば指摘しない。従来の経路は変えない", async () => {
    const { verifyRegistration } = await import("./research-loop");
    const seed = { id: "s1", kind: "seed", url: null, fetchedAt: "x", contentHash: "h", text: "・拡張パック抽選 11/22(日)22:00〆", structure: null, independent: true };
    const pageEv = { id: "p1", kind: "page", url: "https://a.example.invalid/e", fetchedAt: "x", contentHash: "h2", text: "受付は終了しました 拡張パック", structure: null, independent: true };
    const out = (ev: string) => ({ decision: "exclude", fields: { product: { value: "拡張パック", basis: "observed", evidenceId: ev, quote: "拡張パック" }, exclude_reason: { value: "受付終了", basis: "observed", evidenceId: ev, quote: ev === "s1" ? "11/22(日)22:00〆" : "受付は終了しました" } }, rationale: "", unresolvedImpact: "none", monitor: { continue: false, why: "" }, costJpy: 0 }) as never;
    const v = (o: never, evs: unknown[], flag = true) => verifyRegistration({ output: o, evidence: evs as never, protectedFields: {}, registerRequiresUnit: flag, now: new Date("2026-11-25T03:00:00Z") }).issues;
    // CAPABILITY_CEILING（利用者の決定 2026-11-27）: 受付終了は、締切の役割・評価時点より前・矛盾なしの客観的な整合を通れば、応募先のページが無くても止めない（AIが投稿元・延長の有無も踏まえて判断する）
    expect(v(out("s1"), [seed])).toEqual([]);
    // AUTONOMY_RESTORATION（V22）: 応募先のページの有無で除外を止める規則は撤廃した（どの理由でも、意味の判断はAI。引用の実在と申告に応じた客観的な整合だけを確かめる）
    const inel = { ...(out("s1") as unknown as Record<string, unknown>), fields: { product: { value: "拡張パック", basis: "observed", evidenceId: "s1", quote: "拡張パック" }, exclude_reason: { value: "対象外（会員限定）", basis: "observed", evidenceId: "s1", quote: "拡張パック抽選" } } } as never;
    expect(v(inel, [seed])).not.toContain("exclude_without_page_evidence");
    expect(v(out("p1"), [seed, pageEv])).toEqual([]); // 受付終了のページを確認して除外
    expect(v(out("s1"), [seed], false)).toEqual([]); // 従来の経路は変えない
  });
});
