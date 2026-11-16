// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildThreewaySet, scoreField, scoreThreeway, viewFromInput, type ThreewayCase, type View } from "./threeway-review";

/** Stage 9H-3F: 3方式の評価セット（1抽選＝1評価・方式名を伏せ順序ランダム）と自動採点（合成データ） */
const require = createRequire(import.meta.url);
const Core = require("../../../tools/review/review-core.js");

const V = (o: Partial<View> = {}): View => ({ chain: "フルコンプ", store: "店舗選択式（選べる店舗: 横浜店・秋葉原店）", products: ["ハドウシーカー"], applyStart: "2026-11-11", applyDeadline: "2026-11-15 11:59", resultDate: "2026-11-16 〜 2026-11-21", conditions: "LivePocketの会員登録が必要。アンケートへの回答が必要", lotteryForm: "store_select", receiveMethod: "store", applyMethod: "web", ...o });
const mk = (id: string, views: Partial<Record<"A" | "B" | "C", View | null>> = {}): ThreewayCase => ({ caseId: id, patterns: ["store_select"], patternLabels: ["店舗選択式"], source: { url: `https://example.invalid/${id}`, title: id }, views: { A: V({ store: "横浜店", lotteryForm: null, resultDate: "2026-11-16" }), B: V(), C: V(), ...views }, cards: { A: 3, B: 3, C: 1 }, integration: null, sources: ["二次・platform・used: https://example.invalid/x"] });

describe("評価セット: 1抽選＝1評価。方式名は伏せ、順序はランダム。評価ツールの検証に合格する", () => {
  const cases = ["a", "b", "c", "d", "e", "f"].map((x) => mk(x));
  const b = buildThreewaySet(cases, { setId: "rs-test", at: "2026-11-15T00:00:00Z" });
  it("抽選ごとに1事例。評価ツールの事例集として有効で、方式名（従来・AI・統合・A/B/C）が評価画面の文面に出ない", () => {
    expect((b.set.cases as unknown[]).length).toBe(6);
    expect(Core.validateSet(b.set).ok).toBe(true);
    const shown = JSON.stringify(b.set);
    expect(shown).not.toMatch(/従来方式|AI方式|統合方式|"A"|"B"|"C"|A方式|B方式|C方式/);
    expect(shown).toContain("候補1");
    expect(shown).toContain("候補3");
  });
  it("提示順・表示する候補は無作為（再現可能）。対応表に、表示した方式と各候補の方式が残る", () => {
    const b2 = buildThreewaySet(cases, { setId: "rs-test", at: "2026-11-15T00:00:00Z" });
    expect(JSON.stringify(b2.set)).toBe(JSON.stringify(b.set));
    const bases = Object.values(b.key).map((k) => k.base);
    expect(new Set(bases).size).toBeGreaterThan(1); // 同じ方式ばかりを表示しない
    expect(Object.values(b.key)[0].order["候補1"]).toBe(Object.values(b.key)[0].base);
    expect(buildThreewaySet(cases, { setId: "rs-other" }).key).not.toEqual(b.key);
  });
  it("項目ごとの差異・カード数・採用/不採用・統合の判断を、評価画面で確認できる", () => {
    const c = (b.set.cases as { ai: { notices: string[] }; integration: { compare: unknown[]; judgments: string[] } }[])[0];
    expect(c.ai.notices.join("")).toContain("候補の間で値が違う項目");
    expect(c.ai.notices.join("")).toContain("枚");
    expect(c.integration.compare).toHaveLength(3);
    expect(c.integration.judgments.length).toBeGreaterThan(0);
  });
});

describe("登録候補の入力 → 評価に見せる最終候補", () => {
  it("店舗選択式は選べる店舗つきで、当選発表の期間は開始〜終了で表す", () => {
    const v = viewFromInput({ chain: { name: "フルコンプ" }, store: { name: "" }, storeMode: "select_on_apply", selectableStores: [{ name: "横浜店" }, { name: "秋葉原店" }], items: [{ product: { name: "ハドウシーカー" } }], applyStart: { precision: "date_only", date: "2026-11-11", time: "" }, applyDeadline: { precision: "date_time", date: "2026-11-15", time: "11:59" }, resultDate: { precision: "date_only", date: "2026-11-16", time: "" }, resultEndDate: "2026-11-21", conditionsText: "x", receiveMethod: "store", applyMethod: "web" })!;
    expect(v.store).toBe("店舗選択式（選べる店舗: 横浜店・秋葉原店）");
    expect(v.resultDate).toBe("2026-11-16 〜 2026-11-21");
    expect(v.applyDeadline).toBe("2026-11-15 11:59");
    expect(viewFromInput(null)).toBeNull();
  });
});

describe("自動採点: 人間が確定した正しい値だけを基準にする。情報量の多さは正解にしない", () => {
  it("項目の採点: 正しい／誤り／不足。店舗選択式・当選発表の期間・応募期間・受取方法", () => {
    expect(scoreField("store", "店舗選択式", V())).toBe("correct");
    expect(scoreField("store", "店舗選択式", V({ store: "横浜店", lotteryForm: null }))).toBe("wrong");
    expect(scoreField("store", "店舗選択式", V({ store: null }))).toBe("missing");
    expect(scoreField("store", "吉祥寺店", V({ store: "吉祥寺店" }))).toBe("correct");
    expect(scoreField("resultDate", "2026年11月16日（月）～ 11月21日（土）", V())).toBe("correct");
    expect(scoreField("resultDate", "2026年11月16日（月）～ 11月21日（土）", V({ resultDate: "2026-11-18" }))).toBe("wrong");
    expect(scoreField("applyPeriod", "11/11から", V())).toBe("correct");
    expect(scoreField("receiveMethod", "店舗", V())).toBe("correct");
    expect(scoreField("lotteryForm", "店舗選択式", V({ lotteryForm: null }))).toBe("missing");
  });
  it("訂正（正しい値）と、表示した候補を『正しい』とした項目が基準になる。誤った店舗・店舗選択式の見落としは重大な誤りとして数える。判断できない抽選は採点しない", () => {
    const cases = [mk("x"), mk("y"), mk("z")];
    const b = buildThreewaySet(cases, { setId: "rs-score" });
    const idOf = (cid: string) => Object.entries(b.key).find(([, k]) => k.caseId === cid)![0];
    const score = scoreThreeway(
      [
        { caseId: idOf("x"), human: { verdict: "partial", corrections: [{ field: "store", correctValue: "店舗選択式" }], confirmedCorrectFields: ["chain", "resultDate"] } },
        { caseId: idOf("y"), human: { verdict: "correct" } },
        { caseId: idOf("z"), human: { verdict: "unknown" } },
      ],
      b,
      cases,
    );
    expect(score.evaluated).toBe(2);
    expect(score.unknown).toEqual(["z"]);
    // A（従来）は店舗が単独・当選発表が単一日: 店舗選択式の訂正で誤り（重大）。B・Cは店舗選択式で正しい
    expect(score.arms.A.major).toBeGreaterThanOrEqual(1);
    expect(score.arms.C.major).toBe(0);
    expect(score.arms.C.correct).toBeGreaterThan(score.arms.A.correct);
  });
});

describe("実行結果の保存ファイル → 評価セット", () => {
  it("エラーのない事例だけが評価対象になり、確認待ちのカード数・統合の記録・情報源が評価画面の材料になる", async () => {
    const { casesFromRunFiles } = await import("./threeway-review");
    const arm = (cards: number) => ({ openCards: cards, input: { chain: { name: "フルコンプ" }, store: { name: "" }, storeMode: "select_on_apply", selectableStores: [{ name: "横浜店" }], items: [{ product: { name: "ハドウシーカー" } }], applyStart: { precision: "date_only", date: "2026-11-11", time: "" }, applyDeadline: { precision: "date_only", date: "2026-11-15", time: "" }, resultDate: { precision: "unknown", date: "", time: "" }, conditionsText: "", receiveMethod: "unknown", applyMethod: "web" }, judgment: { integration: cards === 1 ? { members: [{ id: "a", label: "候補a" }], excluded: [], adoptions: [], unresolved: [] } : null } });
    const files = [
      { caseId: "n-1", patterns: ["store_select"], error: null, members: [{ id: "m1", url: "https://x.example.invalid/1", title: "t" }], arms: { A: arm(3), B: arm(2), C: arm(1) }, investigation: { result: { sources: [{ url: "https://s.example.invalid/1", kind: "organizer_official", tier: "primary", status: "fetched", fetchedAt: "t" }] } } },
      { caseId: "n-2", patterns: [], error: "実行エラー", members: [], arms: null, investigation: null },
    ];
    const cs = casesFromRunFiles(files, (id) => ({ url: `https://x.example.invalid/${id}`, title: id }));
    expect(cs).toHaveLength(1);
    expect(cs[0].cards).toEqual({ A: 3, B: 2, C: 1 });
    expect(cs[0].integration?.members).toHaveLength(1);
    expect(cs[0].sources.join("")).toContain("一次・organizer_official");
    expect(cs[0].views.C?.lotteryForm).toBe("store_select");
  });
});

describe("9H-3I: 店舗選択式の判断（確認済み／推定／不明）の表示と、評価データへの構造化した記録", () => {
  const F = (state: "confirmed" | "estimated" | "unknown", form: string, extra: object = {}) => ({ state, form, rank: state === "unknown" ? null : 3, confidence: "low", basis: ["根拠のテスト"], ...extra });
  const withForms = (id: string) => ({ ...mk(id), forms: { A: null, B: null, C: F("estimated", "store_select", { refs: ["k"], livepocket: { klass: "C", confidence: "low", missing: [] } }) } });
  it("候補ごとの判断（確認済み／推定／不明）とLivePocketの構造が評価画面の注意欄に出る。表示した候補の構造化した判断が評価データ（ai）に入る。方式名は出ない", () => {
    const cases = ["a", "b", "c"].map((x) => withForms(x));
    const b = buildThreewaySet(cases, { setId: "rs-forms", at: "2026-11-16T00:00:00Z" });
    expect(Core.validateSet(b.set).ok).toBe(true);
    const c0 = (b.set.cases as { ai: { notices: string[]; formJudgment: { state: string } | null } }[])[0];
    expect(c0.ai.notices.join("\n")).toContain("店舗選択式の判断（候補");
    expect(c0.ai.notices.join("\n")).toMatch(/推定|記録なし/);
    const shown = JSON.stringify(b.set);
    expect(shown).not.toMatch(/従来方式|AI方式|統合方式|9H-3F相当|"A"|"B"|"C"/);
    // 表示した候補がC（推定）のときだけ、評価データに推定の記録が入る（警告文から推測しない）
    const base = Object.values(b.key)[0].base;
    expect(c0.ai.formJudgment?.state ?? null).toBe(base === "C" ? "estimated" : null);
  });
  it("表示した候補が『確認済みの店舗別独立』のとき、抽選形態を store_independent として評価に出す（人間が正しいとすれば双方向学習の実績になる）", () => {
    const c = { ...mk("z"), forms: { A: F("confirmed", "store_independent"), B: F("confirmed", "store_independent"), C: F("confirmed", "store_independent") } };
    const b = buildThreewaySet([c], { setId: "rs-ind" });
    const ex = (b.set.cases as { ai: { extracted: { lotteryForm: string | null } } }[])[0].ai.extracted;
    expect(ex.lotteryForm).toBe("store_independent");
  });
});
