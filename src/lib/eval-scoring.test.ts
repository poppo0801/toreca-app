import { describe, expect, it } from "vitest";
// @ts-expect-error 評価基盤（.mjs）。型定義なし
import * as ev from "../../eval/lib.mjs";

type Gold = { id: string; decision: string; conditions?: string[]; duplicateOf?: string; fields: Record<string, unknown>; allowedDecisions?: string[]; mustNotRegister?: boolean };
const cases = ev.loadCases();
const context = ev.loadContext();
const gold: Gold[] = ev.loadGold();
const corpus = ev.loadCorpus();

/** 検証用の「満点」システム。正解を直接読む（採点器の自己検証のためだけ。実システムでは禁止） */
const oracleRun = () => ({
  system: "oracle",
  results: gold.map((g) => ({ caseId: g.id, decision: g.decision, duplicateOf: g.duplicateOf, fields: g.fields, cautions: ["注意"], metrics: { ms: 10, apiCalls: 1, costJpy: 0.5 } })),
});
/** すべて登録してしまう悪いシステム */
const reckless = () => ({
  system: "reckless",
  results: cases.map((c: { id: string }) => ({ caseId: c.id, decision: "register", fields: { chain: "テスト書店", store: "テスト書店 駅前店", products: [{ name: "テストパック 第1弾", quantity: 1, unit: "box" }], applyDeadline: "2027-02-01" }, metrics: { ms: 5, apiCalls: 2, costJpy: 1 } })),
});

describe("評価データの整合（Stage 8D-1）", () => {
  it("入力・正解・資料が検査を通り、件数が一致する", () => {
    expect(ev.validateCases(cases)).toEqual([]);
    expect(ev.validateGold(gold, cases, context)).toEqual([]);
    expect(cases.length).toBe(gold.length);
    expect(corpus.length).toBeGreaterThan(0);
  });
  it("要求された種類（通常・通販・複数商品・店舗選択・継続・日付不明・食い違い・複雑条件・表記ゆれ・同名店舗・重複・別回・店舗未確定・情報不足・誤情報・地域外・閉店・調査で解決）を網羅する", () => {
    const cats = new Set(cases.map((c: { category: string }) => c.category));
    for (const k of ["normal_store", "online", "multi_product", "store_select", "ongoing", "unknown_dates", "source_conflict", "complex_conditions", "chain_variant", "same_name_store", "duplicate_other_source", "same_store_product_other_lottery", "store_unresolved", "insufficient_info", "misinformation", "out_of_area", "closed_store_possible", "resolvable_by_research"]) {
      expect(cats.has(k), k).toBe(true);
    }
  });
  it("入力に正解用のキー（expected・decision・duplicateOf 等）が混入すると検出する", () => {
    const leaked = structuredClone(cases);
    leaked[0].input.expected = { chain: "x" };
    leaked[1].decision = "register";
    const errors = ev.validateCases(leaked);
    expect(errors.some((e: string) => e.includes("expected"))).toBe(true);
    expect(errors.some((e: string) => e.includes("decision"))).toBe(true);
  });
  it("正解の欠落・重複参照先の不在を検出する", () => {
    expect(ev.validateGold(gold.slice(1), cases, context).some((e: string) => e.includes("正解が無い"))).toBe(true);
    const bad = structuredClone(gold);
    bad.find((g) => g.decision === "duplicate")!.duplicateOf = "X99";
    expect(ev.validateGold(bad, cases, context).some((e: string) => e.includes("duplicateOf"))).toBe(true);
  });
  it("runSystem はシステムへ正解を渡さない（入力・既存データ・資料のみ）", () => {
    let seen = "";
    ev.runSystem({ name: "spy", run: (arg: unknown) => { seen += JSON.stringify(arg); return { decision: "needs_human", fields: {} }; } }, cases, context, corpus);
    for (const g of gold) for (const c of g.conditions ?? []) expect(seen.includes(c)).toBe(false);
    expect(seen.includes("mustNotRegister")).toBe(false);
    expect(seen.includes("allowedDecisions")).toBe(false);
  });
});

describe("採点（7項目）", () => {
  it("満点のシステムは、正確性・解決率・重複判定が100%で、誤りが0", () => {
    const s = ev.scoreRun(oracleRun(), gold);
    expect(s.accuracy.decisionAccuracy).toBe(1);
    expect(s.accuracy.fieldAccuracy).toBe(1);
    expect(s.resolution.resolvedRate).toBe(1);
    expect(s.dedupe).toMatchObject({ precision: 1, recall: 1, targetAccuracy: 1, falseDuplicates: 0 });
    expect(s.human.estimatedEdits).toBe(0);
    expect(s.errors).toMatchObject({ wrongRegistrations: 0, forbiddenRegistrations: 0, wrongUpdates: 0, inventedFields: 0, missingCautions: 0 });
    expect(s.api).toEqual({ calls: gold.length, estimatedCostJpy: gold.length * 0.5 });
    expect(s.time.totalMs).toBe(gold.length * 10);
  });
  it("基準線（全件を人手確認）は誤登録が0・人手修正が多い。要確認が許容される件は決定が正解", () => {
    const run = ev.runSystem(ev.trivialAdapter, cases, context, corpus);
    expect(ev.validateRun(run, cases)).toEqual([]);
    const s = ev.scoreRun(run, gold);
    expect(s.errors.forbiddenRegistrations).toBe(0);
    expect(s.errors.wrongRegistrations).toBe(0);
    expect(s.accuracy.fieldAccuracy).toBe(0);
    expect(s.human.estimatedEdits).toBeGreaterThan(0);
    expect(s.human.unnecessaryManualCases).toBeGreaterThan(0);
  });
  it("無謀なシステムは、登録禁止の登録・誤登録・推測した項目が検出される", () => {
    const s = ev.scoreRun(reckless(), gold);
    expect(s.errors.forbiddenRegistrations).toBe(gold.filter((g) => g.mustNotRegister).length);
    expect(s.errors.wrongRegistrations).toBeGreaterThan(5);
    expect(s.errors.inventedFields).toBeGreaterThan(0); // 日付が不明のはずの抽選に日付を作った
    expect(s.accuracy.fieldAccuracy).toBeLessThan(0.5);
    expect(s.accuracy.decisionAccuracy).toBeLessThan(1);
    expect(s.dedupe.recall).toBe(0);
  });
  it("別回の抽選を重複扱いにすると、誤った重複扱いとして数える", () => {
    const run = oracleRun();
    const e12 = run.results.find((r) => r.caseId === "E12")!;
    e12.decision = "duplicate";
    (e12 as { duplicateOf?: string }).duplicateOf = "X02";
    const s = ev.scoreRun(run, gold);
    expect(s.dedupe.falseDuplicates).toBe(1);
    expect(s.dedupe.precision).toBeLessThan(1);
  });
  it("重複の参照先が違えば、決定が重複でも対象の正解率が下がる", () => {
    const run = oracleRun();
    (run.results.find((r) => r.caseId === "E11") as { duplicateOf?: string }).duplicateOf = "X02";
    expect(ev.scoreRun(run, gold).dedupe.targetAccuracy).toBe(0);
  });
  it("欠けた結果は誤りとして数える（結果の欠落で点が上がらない）", () => {
    const run = oracleRun();
    run.results = run.results.slice(2);
    expect(ev.scoreRun(run, gold).accuracy.decisionAccuracy).toBeLessThan(1);
    expect(ev.validateRun(run, cases)).toEqual([]);
  });
  it("閉店注意が要る件に注意が無ければ検出。余計なマスター作成・誤更新も数える", () => {
    const run = oracleRun();
    for (const r of run.results) (r as { cautions?: string[] }).cautions = [];
    (run.results[0] as { createdMasters?: string[] }).createdMasters = ["ＴＥＳＴ　ＢＯＯＫＳ"];
    (run.results[1] as { decision: string }).decision = "update";
    const s = ev.scoreRun(run, gold);
    expect(s.errors.missingCautions).toBe(1);
    expect(s.errors.createdMasters).toBe(1);
    expect(s.errors.wrongUpdates).toBe(1);
  });
  it("項目の比較: 全角半角・空白・日付の時刻部分を吸収し、不明（null）は不明のみ一致", () => {
    expect(ev.fieldMatches("store", "テスト書店 駅前店", "テスト書店　駅前店")).toBe(true);
    expect(ev.fieldMatches("applyDeadline", "2027-01-13", "2027-01-13T23:59:00+09:00")).toBe(true);
    expect(ev.fieldMatches("applyDeadline", null, "2027-01-13")).toBe(false);
    expect(ev.fieldMatches("applyDeadline", null, undefined)).toBe(true);
    expect(ev.fieldMatches("requirementTags", ["a", "b"], ["b", "a"])).toBe(true);
    expect(ev.fieldMatches("products", [{ name: "A", quantity: 1, unit: "box" }], [{ name: "A", quantity: 2, unit: "box" }])).toBe(false);
  });
  it("比較: 差と良し悪しの向き（上がって良い項目・下がって良い項目）", () => {
    const a = ev.scoreRun(ev.runSystem(ev.trivialAdapter, cases, context, corpus), gold);
    const b = ev.scoreRun(oracleRun(), gold);
    const rows = ev.compareScores(a, b) as { label: string; improved: boolean | null }[];
    expect(rows.find((r) => r.label === "項目の正解率")!.improved).toBe(true);
    expect(rows.find((r) => r.label === "推定の人手修正数")!.improved).toBe(true);
    expect(rows.find((r) => r.label === "API呼び出し回数")!.improved).toBe(false); // 満点側は呼び出しが増える
  });
});
