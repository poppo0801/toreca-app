/**
 * 実APIを使う前の関門（Stage 8D-2）。純粋な判定。すべての条件を満たさない限り、実APIには接続しない。
 *  - 開発環境（TOREMANE_ENV=local）でのみ。本番（Vercel）では使えない
 *  - 明示的な許可（AGENT_REAL_API=allow）
 *  - 開発専用のAPIキー（AGENT_ANTHROPIC_API_KEY）。本番の ANTHROPIC_API_KEY とは別物で、同じ値なら拒否する
 *  - 1回あたりの費用上限（AGENT_MAX_COST_JPY_PER_RUN）と、1日の実行回数上限（AGENT_MAX_RUNS_PER_DAY）を設定済み
 *  - 実行ごとの確認（confirm）
 * 既定は何も設定されていない＝モックのみ。実APIは、費用と条件を報告してユーザーが承認したあとに有効にする。
 */
import { DEFAULT_AI_MODEL } from "@/lib/ai-cost";
import { DEFAULT_LIMITS, type AgentLimits } from "@/lib/agent/core";

export type RealGateResult = { ok: true; apiKey: string; model: string; limits: AgentLimits } | { ok: false; reason: string };

export function checkRealApi(input: { env: Record<string, string | undefined>; confirm: boolean; runsToday: number }): RealGateResult {
  const e = input.env;
  if (e.TOREMANE_ENV !== "local") return { ok: false, reason: "実APIは開発環境（TOREMANE_ENV=local）でのみ使えます" };
  if (e.AGENT_REAL_API !== "allow") return { ok: false, reason: "実APIは許可されていません（AGENT_REAL_API=allow が必要）。モックで動作します" };
  const key = e.AGENT_ANTHROPIC_API_KEY?.trim();
  if (!key) return { ok: false, reason: "開発専用のAPIキー（AGENT_ANTHROPIC_API_KEY）が未設定です" };
  if (e.ANTHROPIC_API_KEY?.trim() && e.ANTHROPIC_API_KEY.trim() === key) return { ok: false, reason: "開発専用のキーが本番のキー（ANTHROPIC_API_KEY）と同じです。別のキーを使ってください" };
  const maxCost = Number(e.AGENT_MAX_COST_JPY_PER_RUN);
  const maxRuns = Number(e.AGENT_MAX_RUNS_PER_DAY);
  if (!(maxCost > 0)) return { ok: false, reason: "1回あたりの費用上限（AGENT_MAX_COST_JPY_PER_RUN）が未設定です" };
  if (!(maxRuns > 0)) return { ok: false, reason: "1日の実行回数の上限（AGENT_MAX_RUNS_PER_DAY）が未設定です" };
  if (input.runsToday >= maxRuns) return { ok: false, reason: `本日の実行回数の上限（${maxRuns}回）に達しました` };
  if (!input.confirm) return { ok: false, reason: "実行前の確認が必要です（費用がかかります）" };
  const num = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Math.floor(Number(v)) : d);
  return {
    ok: true,
    apiKey: key,
    model: e.AGENT_MODEL?.trim() || DEFAULT_AI_MODEL,
    limits: { ...DEFAULT_LIMITS, maxCostJpy: maxCost, maxSearches: num(e.AGENT_MAX_SEARCHES, DEFAULT_LIMITS.maxSearches), maxFetches: num(e.AGENT_MAX_FETCHES, DEFAULT_LIMITS.maxFetches), maxSteps: num(e.AGENT_MAX_STEPS, DEFAULT_LIMITS.maxSteps) },
  };
}
