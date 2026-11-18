import { describe, expect, it } from "vitest";
import type { AiLogRow } from "@/lib/ai-cost";
import { buildCostReport, classifyStage, type CandidateCostRow } from "./cost-report";

const T = "2026-11-10T03:00:00Z";
const cand = (o: Partial<CandidateCostRow>): CandidateCostRow => ({ status: "pending", job_state: "review", created_at: T, ...o });
const log = (o: Partial<AiLogRow> = {}): AiLogRow => ({ created_at: T, kind: "url", status: "ok", engine: "anthropic", model: "claude-haiku-5-5", input_tokens: 10000, output_tokens: 1000, ...o });

describe("収集処理の段階別の件数と費用（9H-3L）", () => {
  it("段階の分類: 地域外・商品対象外・重複・取得失敗・保留。1件は1つの段階だけに数える。受付終了の除外は取得失敗にしない", () => {
    expect(classifyStage(cand({ status: "excluded", reasons: ["対象外の地域です（東京都の店舗限定）"] }))).toBe("region");
    expect(classifyStage(cand({ status: "excluded", reasons: ["ポケモンカード以外のTCGの商品です（遊戯王）"] }))).toBe("product");
    expect(classifyStage(cand({ status: "duplicate" }))).toBe("duplicate");
    expect(classifyStage(cand({ job_state: "failed", status: "failed", fail_kind: "blocked" }))).toBe("fetchFailed");
    expect(classifyStage(cand({ status: "excluded", job_state: "skipped", fail_kind: "expired", reasons: ["受付終了"] }))).toBeNull();
    expect(classifyStage(cand({ triage: "auto_retry" }))).toBe("held");
    expect(classifyStage(cand({ triage: "manual" }))).toBe("held");
    expect(classifyStage(cand({}))).toBeNull();
  });
  it("AIの前（解析回数0＝費用なし）と後（解析あり）に分ける。有料AIの後で除外・重複と分かった件数も数える", () => {
    const r = buildCostReport({
      candidates: [
        cand({ status: "excluded", reasons: ["対象外の地域です"], ai_calls: 0 }),
        cand({ status: "excluded", reasons: ["対象外の地域です"], ai_calls: 1 }),
        cand({ status: "duplicate", ai_calls: 1 }),
        cand({ status: "excluded", reasons: ["別ゲームの商品"], ai_calls: 0 }),
        cand({ ai_calls: 1 }),
      ],
      logs: [],
    });
    expect(r.stages).toMatchObject({ collected: 5, aiAnalyzed: 3, region: { beforeAi: 1, afterAi: 1 }, product: { beforeAi: 1, afterAi: 0 }, duplicate: { beforeAi: 0, afterAi: 1 } });
    expect(r.afterAiDiscarded).toBe(2);
  });
  it("費用はAI利用ログだけから算出する（候補の解析回数や統計の費用を足さない＝二重計上しない）", () => {
    const logs = [log(), log({ created_at: "2026-11-11T03:00:00Z" })];
    const once = buildCostReport({ candidates: [cand({ ai_calls: 5 }), cand({ ai_calls: 5 })], logs });
    const twice = buildCostReport({ candidates: [], logs });
    expect(once.ai.costJpy).toBe(twice.ai.costJpy);
    expect(once.ai.calls).toBe(2);
    // 10000入力・1000出力トークン（haiku）= (10000*0.1+1000*0.5)/1e6*150 円
    expect(once.ai.costJpy).toBeCloseTo(2 * (((10000 * 0.1 + 1000 * 0.5) / 1_000_000) * 150), 3);
    expect(once.days.map((d) => d.day)).toEqual(["2026-11-11", "2026-11-10"]);
    expect(once.days.reduce((a, d) => a + d.aiCostJpy, 0)).toBeCloseTo(once.ai.costJpy, 3);
  });
  it("費用が不明な呼び出し（モデル・トークン数が不明）は0円にせず「不明」として別に数える。平均は推定できたものだけ。モックやAIを呼んでいないものは数えない", () => {
    const r = buildCostReport({ candidates: [cand({ ai_calls: 1 }), cand({ ai_calls: 1 })], logs: [log(), log({ model: null }), log({ input_tokens: null }), log({ engine: "mock" }), log({ engine: "none" })] });
    expect(r.ai.calls).toBe(3);
    expect(r.ai.unknownCalls).toBe(2);
    expect(r.ai.byModel.find((m) => m.model === "（モデル不明）")?.unknownCalls).toBe(1);
    expect(r.ai.avgPerCallJpy).toBeCloseTo(r.ai.costJpy, 4); // 推定できた1回だけの平均
    const none = buildCostReport({ candidates: [cand({ ai_calls: 1 })], logs: [log({ model: null })] });
    expect(none.ai.costJpy).toBe(0);
    expect(none.ai.unknownCalls).toBe(1);
    expect(none.ai.avgPerCallJpy).toBeNull(); // 0円ではなく不明
    expect(none.ai.avgPerAnalyzedCandidateJpy).toBeNull();
  });
  it("モデル別の回数・トークン・費用。検索APIは、記録が無いときは未記録（0にしない）、あるときは検索の回数と費用だけ（AI費用と区別）", () => {
    const logs = [log(), log({ model: "claude-sonnet-5-5" }), log()];
    const r = buildCostReport({ candidates: [], logs });
    expect(r.ai.byModel.map((m) => [m.model, m.calls])).toEqual([["claude-haiku-5-5", 2], ["claude-sonnet-5-5", 1]]);
    expect(r.ai.byModel[0].inputTokens).toBe(20000);
    expect(r.search).toEqual({ recorded: false, calls: null, costJpy: null });
    const s = buildCostReport({ candidates: [], logs: [], searchSteps: [{ created_at: T, tool: "web_search", cost_jpy: 1.5 }, { created_at: T, tool: "fetch_source_page", cost_jpy: 0 }, { created_at: T, tool: "web_search", cost_jpy: "2.5" }] });
    expect(s.search).toEqual({ recorded: true, calls: 2, costJpy: 4 });
    expect(buildCostReport({ candidates: [], logs: [], searchSteps: [] }).search).toEqual({ recorded: true, calls: 0, costJpy: 0 });
  });
  it("日付は日本時間で区切る（UTCの夜は翌日）。解析した候補1件あたりの平均を出す", () => {
    const r = buildCostReport({ candidates: [cand({ created_at: "2026-11-10T16:00:00Z", ai_calls: 1 }), cand({ created_at: "2026-11-10T14:00:00Z", ai_calls: 1 })], logs: [log(), log()] });
    expect(r.days.map((d) => [d.day, d.stages.collected])).toEqual([["2026-11-11", 1], ["2026-11-10", 1]]);
    expect(r.ai.avgPerAnalyzedCandidateJpy).toBeCloseTo(r.ai.costJpy / 2, 4);
  });
});
