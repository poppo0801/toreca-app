// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyItemsChange } from "@/lib/collector/product-text";
import { classifyStops, runVerification, type CaseSignals } from "./verification-runner";

/** Stage 9H-3I: 安全停止の範囲（案件単位の隔離／検証全体の停止）と、再開・集計の整合性 */
const LIM = { perCaseCapJpy: 12, totalCapJpy: 80, spentBeforeJpy: 0 };
const ok = (cost = 5): CaseSignals => ({ costJpy: cost, investigationCalls: 1 });
const diffProduct: CaseSignals = { costJpy: 6, investigationCalls: 1, itemsChanges: [classifyItemsChange(["拡張パック ハドウシーカー"], ["拡張パック ハドウシーカー", "30th CELEBRATION カードセット 9種セット"])] };
const run = (ids: string[], by: Record<string, CaseSignals | Error>, done: string[] = [], limits = LIM) => {
  const called: string[] = [];
  return runVerification({
    caseIds: ids,
    done: new Set(done),
    limits,
    execute: async (id) => {
      called.push(id);
      const v = by[id] ?? ok();
      if (v instanceof Error) throw v;
      return v;
    },
  }).then((s) => ({ s, called }));
};

describe("停止範囲: 案件単位の問題は隔離して他の案件を続ける", () => {
  it("1案件の誤統合疑い（異なる商品の混入）で、他の案件は停止しない。隔離した案件も集計に残り、理由が保存される", async () => {
    const { s, called } = await run(["a", "b", "c", "d"], { b: diffProduct });
    expect(called).toEqual(["a", "b", "c", "d"]);
    expect(s.globalStop).toBeNull();
    expect(s.outcomes.map((o) => o.status)).toEqual(["completed", "quarantined", "completed", "completed"]);
    expect(s.outcomes[1].reasons.join("")).toContain("商品構成の不一致（added_different）");
    expect(s).toMatchObject({ executed: 4, completed: 3, quarantined: 1, notRun: 0 });
  });
  it("異なる商品の混入・置き換え・商品名を判断できない: 検出して隔離する。同じ商品の詳細の追加は隔離しない", () => {
    const l = { ...LIM, spentAfterJpy: 5 };
    const q = (b: string[], a: string[]) => classifyStops({ costJpy: 3, itemsChanges: [classifyItemsChange(b, a)] }, l).quarantine.length;
    expect(q(["拡張パック ハドウシーカー"], ["拡張パック ハドウシーカー", "拡張パック ニンジャスピナー"])).toBe(1);
    expect(q(["拡張パック ハドウシーカー"], ["拡張パック ニンジャスピナー"])).toBe(1);
    expect(q(["拡張パック ハドウシーカー"], ["販売価格：3000円"])).toBe(1);
    expect(q(["拡張パック ハドウシーカー"], ["拡張パック ハドウシーカー 購入可能数：1人1BOXまで"])).toBe(0);
  });
  it("系列・店舗の変更（誤統合の疑い）・根拠のない確定・命令らしき文面・個別案件の取得失敗は、案件単位で隔離する", async () => {
    const { s } = await run(["a", "b", "c", "d", "e"], { a: { costJpy: 1, chainStoreChanges: ["store 新宿店→渋谷店"] }, b: { costJpy: 1, unsupportedConfirmed: ["applyDeadline"] }, c: { costJpy: 1, injectionFlags: 2 }, d: new Error("ページを取得できませんでした（404）") });
    expect(s.outcomes.map((o) => o.status)).toEqual(["quarantined", "quarantined", "quarantined", "quarantined", "completed"]);
    expect(s.globalStop).toBeNull();
  });
});

describe("停止範囲: 共通の異常・費用は検証全体を停止する", () => {
  it("1件の費用が上限に到達 → 全体停止。以降は未実行（理由つき）", async () => {
    const { s, called } = await run(["a", "b", "c"], { a: ok(12.5) });
    expect(s.globalStop).toContain("1件の費用が上限");
    expect(called).toEqual(["a"]);
    expect(s.outcomes.map((o) => o.status)).toEqual(["quarantined", "not_run", "not_run"]);
    expect(s.outcomes[0].reasons[0]).toContain("【全体停止】");
  });
  it("累計の費用が上限に到達、または次の1件で上限を超える恐れがあるときは、呼び出しの前に全体停止する", async () => {
    const { s, called } = await run(["a", "b", "c"], {}, [], { ...LIM, spentBeforeJpy: 70 });
    expect(called).toEqual([]);
    expect(s.globalStop).toContain("上限");
    expect(s.notRun).toBe(3);
    const r2 = await run(["a", "b"], { a: ok(11) }, [], { ...LIM, spentBeforeJpy: 60, totalCapJpy: 80 });
    expect(r2.s.globalStop).toContain("上限");
    expect(r2.called).toEqual(["a"]);
  });
  it("共通処理の重大な異常（調査の複数回実行・推定の自動登録・複数案件にまたがるデータ混入・無限ループ・費用の関門の停止）は全体停止", async () => {
    for (const bad of [{ investigationCalls: 2 }, { estimateAutoRegistered: true }, { foreignCaseIds: ["k-zzzz"] }, { loops: 3 }, { guardStopped: "上限" }] as Partial<CaseSignals>[]) {
      const { s, called } = await run(["a", "b"], { a: { costJpy: 2, investigationCalls: 1, ...bad } });
      expect(s.globalStop, JSON.stringify(bad)).not.toBeNull();
      expect(called).toEqual(["a"]);
    }
  });
  it("費用・認証・本番に関わる例外は全体停止。それ以外の例外は案件単位", async () => {
    expect((await run(["a", "b"], { a: new Error("費用の上限を超える見込み") })).s.globalStop).not.toBeNull();
    expect((await run(["a", "b"], { a: new Error("本番への接続を検出") })).s.globalStop).not.toBeNull();
    expect((await run(["a", "b"], { a: new Error("取得に失敗") })).s.globalStop).toBeNull();
  });
});

describe("再開と集計の整合性", () => {
  it("再開時に、完了済み・隔離済みの案件を二重に実行しない（費用も加えない）", async () => {
    const { s, called } = await run(["a", "b", "c", "d"], {}, ["a", "b"]);
    expect(called).toEqual(["c", "d"]);
    expect(s.outcomes.map((o) => o.status)).toEqual(["skipped_done", "skipped_done", "completed", "completed"]);
    expect(s.skippedDone).toBe(2);
    expect(s.spentJpy).toBe(10);
  });
  it("評価件数・費用・隔離件数・未実行件数の合計が、対象件数と一致する。隔離案件を黙って除外しない", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const { s } = await run(ids, { b: diffProduct, c: ok(13), }, ["a"]);
    expect(s.outcomes).toHaveLength(ids.length);
    expect(s.skippedDone + s.executed + s.notRun).toBe(ids.length);
    expect(s.completed + s.quarantined).toBe(s.executed);
    expect(s.spentJpy).toBeCloseTo(s.outcomes.reduce((a, o) => a + o.costJpy, 0), 3);
    expect(s.outcomes.filter((o) => o.status === "quarantined").map((o) => o.caseId)).toEqual(["b", "c"]);
  });
});
