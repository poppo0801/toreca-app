// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runEval, runEvalCase } from "@/lib/ai/eval";
import { EVAL_CASES } from "@/lib/ai/eval-cases";

/** 固定のAI応答による回帰評価（APIは呼ばない）。実AIでの評価は e2e/ai-live.spec.ts を明示的に実行する */
describe("AI解析の回帰評価（固定応答）", () => {
  it.each(EVAL_CASES.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = runEvalCase(c);
    expect(r.failures).toEqual([]);
  });
  it("全ケースの集計", () => {
    const r = runEval(EVAL_CASES);
    expect(r.passed).toBe(r.total);
  });
  it("期待に反する場合は失敗として報告する（評価器自体の確認）", () => {
    const r = runEvalCase({ ...EVAL_CASES[0], expect: { applyDeadline: "2027-12-20" } });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("applyDeadline");
  });
});
