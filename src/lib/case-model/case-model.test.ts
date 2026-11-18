// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeExtraction } from "@/lib/ai/extraction";
import { validateExtraction } from "@/lib/ai/validate";
import { buildAiContext } from "./context";
import { unifiedMode } from "./flag";
import { caseFromExtraction } from "./from-extraction";
import { buildHumanKnowledge, humanHintsFor, type AnswersFileLike } from "./human-knowledge";
import { buildJudgment, diffDecisions, investigationNeeds, silentChanges } from "./judgment";
import { applyCaseFileToExtraction } from "./merge";
import { aiInputRecord, redact } from "./redact";
import { emptyCase, type CaseFile } from "./types";

/** Stage 9H-3B: 共通モデル・判断履歴・参考情報・合流の規則（純関数。実AI・DBなし）。AIの生出力 → 実際の正規化・検証（normalizeExtraction / validateExtraction）を通して使う */

const NOW = new Date("2026-11-14T03:00:00Z");
const none = { year: null, month: null, day: null, hour: null, minute: null };
function rawAi(o: Record<string, unknown> = {}) {
  return {
    is_lottery_announcement: true,
    chain_name: "テスト星",
    store_name: "",
    prefecture: "",
    products: [{ name: "ハドウシーカー", code: "", quantity: 1, unit: "box" }],
    apply_start: { year: 2026, month: 11, day: 11, hour: 12, minute: 0 },
    apply_deadline: { year: 2026, month: 11, day: 15, hour: 11, minute: 59 },
    result_date: { year: 2026, month: 11, day: 16, hour: null, minute: null },
    result_end_date: none,
    procedure_start: none,
    procedure_deadline: none,
    conditions_text: "会員登録が必要",
    receive_method: "store",
    apply_method: "web",
    apply_url: "",
    apply_unit: "unknown",
    selectable_stores: [],
    evidence: [],
    warnings: [],
    ...o,
  };
}
const extract = (o: Record<string, unknown> = {}, text: string | null = null) => validateExtraction(normalizeExtraction(rawAi(o), NOW, {}), text, {});
const aiCase = (o: Record<string, unknown> = {}) => caseFromExtraction(extract(o), "k1", { url: "https://s.example.invalid/a", at: NOW.toISOString() });

describe("共通基盤のフラグ", () => {
  it("本番では、環境変数が何であっても無効。開発環境でも明示的にオンにしたときだけ有効", () => {
    expect(unifiedMode({})).toEqual({ judgment: false, investigate: false });
    expect(unifiedMode({ NODE_ENV: "production", COLLECT_UNIFIED: "on", COLLECT_INVESTIGATE: "on" })).toEqual({ judgment: false, investigate: false });
    expect(unifiedMode({ TOREMANE_ENV: "production", COLLECT_UNIFIED: "on" })).toEqual({ judgment: false, investigate: false });
    expect(unifiedMode({ TOREMANE_ENV: "local" })).toEqual({ judgment: false, investigate: false });
    expect(unifiedMode({ TOREMANE_ENV: "local", COLLECT_UNIFIED: "on" })).toEqual({ judgment: true, investigate: false });
    expect(unifiedMode({ TOREMANE_ENV: "local", COLLECT_INVESTIGATE: "on" })).toEqual({ judgment: false, investigate: false }); // 調査だけの指定は無効
    expect(unifiedMode({ TOREMANE_ENV: "local", COLLECT_UNIFIED: "on", COLLECT_INVESTIGATE: "on" })).toEqual({ judgment: true, investigate: true });
  });
});

describe("共通モデル: 実際の抽出（正規化・検証）の結果から案件ファイルを作る", () => {
  it("AIの読み取りは『推定』（確定ではない）。当選発表の期間・店舗選択式・選べる店舗が欄として保持される", () => {
    const c = aiCase({ result_date: { year: 2026, month: 11, day: 16, hour: null, minute: null }, result_end_date: { year: 2026, month: 11, day: 21, hour: null, minute: null }, apply_unit: "store_select", selectable_stores: ["横浜店", "秋葉原店"] });
    expect(c.fields.resultStart).toMatchObject({ value: "2026-11-16", by: "ai" });
    expect(c.fields.resultEnd.value).toBe("2026-11-21");
    expect(c.fields.form.value).toBe("store_select");
    expect(c.fields.selectableStores.value).toBe("横浜店 / 秋葉原店");
    expect(c.fields.applyDeadline.value).toBe("2026-11-15 11:59");
    expect(Object.values(c.fields).every((f) => f.state !== "confirmed")).toBe(true);
  });
});

describe("判断履歴: AIが読んだ値が、どの処理で変わったか", () => {
  it("表記の違い・マスターの正式名称への照合は『変更』にしない。値が変わったときだけ記録し、理由が無ければ『理由の記録なし』と目立たせる", () => {
    const ai = aiCase({ chain_name: "イトーヨーカドーネット通販", store_name: "通販" });
    const fin = emptyCase("k1", NOW.toISOString());
    for (const k of Object.keys(ai.fields) as (keyof CaseFile["fields"])[]) fin.fields[k] = { ...ai.fields[k] };
    fin.fields.chain = { ...fin.fields.chain, value: "イトーヨーカドー" }; // 正規化（同じ意味）
    fin.fields.applyDeadline = { ...fin.fields.applyDeadline, value: "2026-11-15 23:59" }; // 値の変更
    fin.fields.store = { ...fin.fields.store, value: null }; // 破棄
    const d = diffDecisions(ai, fin, []);
    expect(d.find((x) => x.field === "chain")).toBeUndefined();
    expect(d.find((x) => x.field === "applyDeadline")).toMatchObject({ kind: "changed", before: "2026-11-15 11:59", after: "2026-11-15 23:59", reason: expect.stringContaining("理由の記録なし") });
    expect(d.find((x) => x.field === "store")).toMatchObject({ kind: "dropped", before: "通販", after: null });
    const j = buildJudgment({ at: "t", aiInput: null, ai, final: fin });
    expect(silentChanges(j).map((x) => x.field).sort()).toEqual(["applyDeadline", "store"]);
    // 理由が分かっている変更（トレース・説明つき）は『理由の記録なし』にならない
    const j2 = buildJudgment({ at: "t", aiInput: null, ai, final: fin, trace: [{ stage: "fixed", field: "store", value: "通販を店舗なしに", by: "fixed", note: "通販は店舗を持たない" }], explained: { applyDeadline: { by: "investigation", reason: "公式ページで確認" } } });
    expect(silentChanges(j2)).toHaveLength(0);
  });
});

describe("AI調査が必要な案件の判定", () => {
  it("正常に見える案件は対象にしない。取得制限・必須不足・系列不明・店舗の羅列・根拠が弱い項目は対象にする", () => {
    expect(investigationNeeds(aiCase({ store_name: "本店" })).needed).toBe(false);
    expect(investigationNeeds(aiCase({ store_name: "本店" }), { fetchRestricted: true }).reasons.map((r) => r.code)).toContain("fetch_restricted");
    expect(investigationNeeds(aiCase({ chain_name: "", store_name: "本店" })).reasons.map((r) => r.code)).toContain("chain_unidentified");
    expect(investigationNeeds(aiCase({ products: [], store_name: "本店" })).reasons.map((r) => r.code)).toContain("required_missing");
    const many = investigationNeeds(aiCase({ store_name: "", selectable_stores: ["横浜店", "秋葉原店", "渋谷店"] }));
    expect(many.reasons.map((r) => r.code)).toContain("form_undecidable");
    // 店舗選択式と判断できていれば、店舗が空でも店舗不明にしない
    expect(investigationNeeds(aiCase({ store_name: "", apply_unit: "store_select", selectable_stores: ["横浜店", "秋葉原店"] })).reasons.map((r) => r.code)).not.toContain("store_unidentified");
    expect(investigationNeeds(aiCase({ store_name: "本店" }), { duplicateDoubt: true }).reasons.map((r) => r.code)).toContain("duplicate_doubt");
  });
});

describe("調査結果の合流（ExtractedLottery への反映）: 黙って置き換えない・捨てない・人間の確定を守る", () => {
  const invCase = (patch: (c: CaseFile) => void): CaseFile => {
    const c = emptyCase("k1", NOW.toISOString());
    patch(c);
    return c;
  };
  const ev = [{ url: "https://official.example.invalid/x", quote: "原文", tier: "primary" as const }];

  it("読み取りが空の項目は調査で補う（確定以外は未確認の注意つき）。当選発表の開始・終了・店舗選択式が保持される", () => {
    const ex = extract({ result_date: none, store_name: "" });
    const inv = invCase((c) => {
      c.fields.resultStart = { value: "2026-11-16", state: "unverified", by: "investigation", evidence: ev, alternatives: [] };
      c.fields.resultEnd = { value: "2026-11-21", state: "unverified", by: "investigation", evidence: ev, alternatives: [] };
      c.fields.form = { value: "store_select", state: "confirmed", by: "investigation", evidence: ev, alternatives: [] };
      c.fields.selectableStores = { value: "横浜店 / 秋葉原店", state: "confirmed", by: "investigation", evidence: ev, alternatives: [] };
    });
    const m = applyCaseFileToExtraction(ex, inv);
    expect(m.extraction.resultDate).toMatchObject({ precision: "date_only", date: "2026-11-16" });
    expect(m.extraction.resultEndDate).toBe("2026-11-21");
    expect(m.extraction.applyUnit).toBe("store_select");
    expect(m.extraction.selectableStoreNames).toEqual(["横浜店", "秋葉原店"]);
    expect(m.extraction.warnings.some((w) => w.includes("当選発表（開始）を補いました（未確認"))).toBe(true);
    expect(m.applied).toBe(4);
  });

  it("既存の読み取りと違う値: 調査が『確定』のときだけ置き換え（記録あり）。確定でなければ置き換えず、食い違いを注意と未反映情報に残す", () => {
    const ex = extract();
    const confirmed = invCase((c) => (c.fields.applyDeadline = { value: "2026-11-16 23:59", state: "confirmed", by: "investigation", evidence: ev, alternatives: [] }));
    const m1 = applyCaseFileToExtraction(ex, confirmed);
    expect(m1.extraction.applyDeadline).toMatchObject({ date: "2026-11-16", time: "23:59" });
    expect(m1.decisions[0]).toMatchObject({ kind: "changed", before: "2026-11-15 11:59", after: "2026-11-16 23:59", by: "investigation" });
    const weak = invCase((c) => (c.fields.applyDeadline = { value: "2026-11-16 23:59", state: "unverified", by: "investigation", evidence: ev, alternatives: [] }));
    const m2 = applyCaseFileToExtraction(ex, weak);
    expect(m2.extraction.applyDeadline).toMatchObject({ date: "2026-11-15", time: "11:59" }); // 置き換えない
    expect(m2.decisions[0]).toMatchObject({ kind: "held" });
    expect(m2.unreflected[0]).toMatchObject({ key: "applyDeadline", value: "2026-11-16 23:59" });
    expect(m2.extraction.warnings.some((w) => w.includes("食い違っています"))).toBe(true);
  });

  it("日時の境界表現（1分差）・日付のみと時刻つきは同じ意味: 保留にせず、安全側（早い方・時刻つき）に揃えて理由を残す。値が同じ意味のとき『理由の記録なし』を出さない", () => {
    const ex = extract({ apply_deadline: { year: 2026, month: 11, day: 15, hour: 12, minute: 0 }, result_date: { year: 2026, month: 11, day: 16, hour: null, minute: null } });
    const inv = invCase((c) => {
      c.fields.applyDeadline = { value: "2026-11-15 11:59", state: "unverified", by: "investigation", evidence: ev, alternatives: [] };
      c.fields.resultStart = { value: "2026-11-16 15:00", state: "unverified", by: "investigation", evidence: ev, alternatives: [] };
    });
    const m = applyCaseFileToExtraction(ex, inv);
    expect(m.extraction.applyDeadline).toMatchObject({ date: "2026-11-15", time: "11:59" });
    expect(m.extraction.resultDate).toMatchObject({ date: "2026-11-16", time: "15:00", precision: "date_time" });
    expect(m.decisions.map((d) => d.kind)).toEqual(["changed", "changed"]);
    expect(m.decisions[0].reason).toContain("一致"); // 同じ日時の表記差は、統合で安全側（早い方・時刻つき）に揃う
    expect(m.unreflected).toEqual([]);
  });

  it("人間が確定した項目は、調査が確定でも上書きしない（拒否の記録を残す）", () => {
    const ex = extract();
    const inv = invCase((c) => (c.fields.applyDeadline = { value: "2026-11-30 23:59", state: "confirmed", by: "investigation", evidence: ev, alternatives: [] }));
    const m = applyCaseFileToExtraction(ex, inv, { humanLocked: ["applyDeadline"] });
    expect(m.extraction.applyDeadline).toMatchObject({ date: "2026-11-15", time: "11:59" });
    expect(m.decisions[0]).toMatchObject({ kind: "rejected", reason: expect.stringContaining("人間が確定") });
  });

  it("矛盾した項目・登録候補に変換できない値は、捨てずに未反映情報として残す。表記の違いだけの値は変更にしない", () => {
    const ex = extract({ store_name: "本店" });
    const inv = invCase((c) => {
      c.fields.store = { value: "旗艦店", state: "conflict", by: "investigation", evidence: ev, alternatives: [{ value: "本店", evidence: [] }] };
      c.fields.applyMethod = { value: "serial", state: "confirmed", by: "investigation", evidence: ev, alternatives: [] }; // 既存の形式にない
      c.fields.chain = { value: "テスト星 ", state: "confirmed", by: "investigation", evidence: ev, alternatives: [] }; // 同じ意味
    });
    const m = applyCaseFileToExtraction(ex, inv);
    expect(m.extraction.storeName).toBe("本店");
    expect(m.unreflected.map((u) => `${u.key}:${u.value}`)).toEqual(expect.arrayContaining(["store:旗艦店", "applyMethod:serial"])); // 決められない別の値・形式に変換できない値は、捨てずに保持
    expect(m.decisions.find((d) => d.field === "chain")).toBeUndefined();
    expect(m.extraction.applyMethod).toBe("web");
    expect(m.extraction.warnings.some((w) => w.includes("店舗が情報源どうしで食い違"))).toBe(true);
  });

  it("当選発表の終了が開始より前の値は採用しない", () => {
    const ex = extract({ result_date: { year: 2026, month: 11, day: 20, hour: null, minute: null } });
    const inv = invCase((c) => (c.fields.resultEnd = { value: "2026-11-18", state: "confirmed", by: "investigation", evidence: ev, alternatives: [] }));
    const m = applyCaseFileToExtraction(ex, inv);
    expect(m.extraction.resultEndDate).toBe("");
    expect(m.decisions.some((d) => d.kind === "rejected" && d.field === "resultEnd")).toBe(true);
  });
});

describe("保存する入力の記録: 伏せ字・短縮（キー・認証情報・個人情報を保存しない）", () => {
  it("APIキー・メール・電話・住所らしき文字列は伏せ、本文は短い抜粋とハッシュだけを残す", () => {
    const text = `応募はこちら api_key=sk-ant-abcdef1234567890 連絡先 taro@example.com 03-1234-5678 〒100-0001 東京都千代田区1-1\n${"あ".repeat(3000)}`;
    const r = aiInputRecord({ kind: "x_url", sourceUrl: "https://x.com/a/status/1", text, context: ["表示名「店」"] });
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/sk-ant|taro@|03-1234|千代田/);
    expect(r.textLength).toBe(text.length);
    expect(r.textExcerpt.length).toBeLessThanOrEqual(1210);
    expect(r.textDigest).toHaveLength(16);
    expect(redact("Bearer abcdefghijklmnop")).toBe("[認証情報]");
  });
  it("AIへ渡す参考情報は告知本文と区別され、告知に根拠の無い情報に使わない旨を明記する", () => {
    const c = buildAiContext({ account: { username: "tc_4145", displayName: "ガンリュウ アリオ葛西店" }, humanHints: ["参考の判断"] });
    expect(c.block).toContain("告知本文ではありません");
    expect(c.block).toContain("ガンリュウ アリオ葛西店");
    expect(buildAiContext({}).block).toBe("");
  });
});

/** 人間の評価JSON（9F-2の書き出しと同じ形）。実ファイルから抜粋した形の例 */
const ANSWERS: AnswersFileLike[] = [
  {
    results: [
      { caseId: "k-83ed2203", aiOriginal: { extracted: { chain: "カードショップホビビ通販部", store: "オンライン" } }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "chain", correctValue: "カードショップホビビ" }, { field: "store", correctValue: "通販" }] } },
      { caseId: "k-9e5d05dc", aiOriginal: { extracted: { chain: "キデイランド", store: "二子玉川店" } }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "store", correctValue: "店舗選択式" }], comment: "いずれか1店舗のみで応募可" } },
      { caseId: "k-1d2511ea", aiOriginal: { extracted: { chain: "フルコンプ", store: null } }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "store", correctValue: "店舗選択式" }, { field: "decision", correctValue: "register" }], comment: "livepocketの場合、すべて本文を優先する。" } },
      { caseId: "k-alias", aiOriginal: { extracted: { chain: "ガンリュウ表記", store: null } }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "chain", correctValue: "ガンリュウ" }] } },
      { caseId: "k-bad", aiOriginal: { extracted: { chain: "不明系列", store: null } }, human: { verdict: "unknown", usableAsGold: false, corrections: [{ field: "store", correctValue: "店舗選択式" }] } },
    ],
  },
];
describe("人間の評価・修正履歴 → AIへの参考情報（過去の判断を今回の正解にしない）", () => {
  const k = buildHumanKnowledge(ANSWERS);
  it("系列の別名・店舗選択式の判断・店舗名の訂正・決定を抜き出す。正解として使えない評価（usableAsGold=false）は使わない", () => {
    expect(k.entries).toEqual(
      expect.arrayContaining([
        { kind: "chain_alias", alias: "ガンリュウ表記", canonical: "ガンリュウ", caseId: "k-alias" },
        { kind: "store_name", chain: "カードショップホビビ", store: "通販", caseId: "k-83ed2203" },
        { kind: "store_form", chain: "キデイランド", form: "store_select", caseId: "k-9e5d05dc" },
        { kind: "store_form", chain: "フルコンプ", form: "store_select", caseId: "k-1d2511ea" },
      ]),
    );
    expect(JSON.stringify(k)).not.toContain("不明系列");
  });
  it("該当する系列の情報だけを、『参考。今回の告知を優先』と明示して渡す。応募条件・日程は渡さない", () => {
    const h = humanHintsFor(k, { chain: "フルコンプ", texts: ["フルコンプ ハドウシーカー 抽選"] });
    expect(h.length).toBeGreaterThan(0);
    expect(h.every((x) => x.includes("今回の告知の記載を優先"))).toBe(true);
    expect(h.join("")).toContain("店舗選択式");
    expect(h.join("")).toContain("本文を優先");
    expect(h.join("")).not.toMatch(/\d{4}-\d{2}-\d{2}|締切/);
    // 別名: 旧表記の系列名でも、正式名称の判断が見つかる
    expect(humanHintsFor(k, { chain: "ガンリュウ表記" }).join("")).toContain("「ガンリュウ」として扱われた");
    // 系列名の正規化（通販部など）で同じになる表記は、別名の記録を作らない（既存の正規化に任せる）
    expect(k.entries.some((e) => e.kind === "chain_alias" && e.alias.includes("ホビビ"))).toBe(false);
    // 無関係な系列には何も渡さない
    expect(humanHintsFor(k, { chain: "無関係な店", texts: ["別の告知"] })).toEqual([]);
  });
  it("実際の評価ファイル（backups/review-answers。あれば）から、評価で指摘された系列・店舗選択式の判断が取り出せる", () => {
    const dir = "backups/review-answers";
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as AnswersFileLike);
    const real = buildHumanKnowledge(files);
    expect(real.entries.length).toBeGreaterThan(0);
    expect(humanHintsFor(real, { chain: "キデイランド" }).join("")).toContain("店舗選択式");
    expect(humanHintsFor(real, { chain: "フルコンプ" }).join("")).toContain("店舗選択式");
  });
});
