/**
 * 調査の安全制御（Stage 9D・純関数）。AIの外側で決まり、**AIは変更できない**（ツールの入力にも出力にも、上限・権限・アクセス範囲を変える項目は無い）。
 *   - 固定の上限（FIXED_CONTROLS）は凍結したオブジェクト。実行ごとの上限は、ここで日次の使用状況から決める
 *   - 1日あたりの調査回数・解析件数・費用。既存の「1日の解析上限（worker_daily_ai_limit。既定30）と一時的な引き上げ」は変更せず、残りの枠の範囲でだけ使う
 *   - 1回の調査: ツール実行回数・取得回数・解析回数・再調査の深さ・同一サイトへのアクセス頻度・費用・時間
 */
import { DEFAULT_LIMITS, type AgentLimits } from "@/lib/agent/core";
import type { ThrottleOptions } from "@/lib/agent/collection-planner/throttle";

export const FIXED_CONTROLS = Object.freeze({
  /** 1日の調査の実行回数 */
  maxRunsPerDay: 6,
  /** 1日の調査（実API）の費用の上限（円）。モックは0円 */
  maxCostPerDayJpy: 30,
  /** 1回の調査で解析（抽選情報の読み取り）できるページ数 */
  maxAnalysesPerRun: 3,
  /** 1回の調査の費用の上限（円） */
  maxCostPerRunJpy: 15,
  /** 1回の調査のツール実行回数・取得回数・検索回数 */
  maxSteps: 12,
  maxFetches: 6,
  maxSearches: 3,
  /** リンクをたどる深さ（公式サイト→応募ページ→まで） */
  maxFollowDepth: 2,
  /** 同じサイトへのアクセス: 1回の調査の上限回数と最小間隔 */
  perHostMax: 3,
  minIntervalMs: 1500,
  /** 1回の調査の処理時間 */
  maxMs: 90_000,
  /** 情報源の失敗がこの回数続いたら、しばらくその情報源を避ける（回避せず、停止して復旧を待つ） */
  failuresBeforeBackoff: 2,
  backoffDays: 3,
});

export interface DailyUsage {
  runsToday: number;
  costTodayJpy: number;
  /** 世帯の1日の解析上限（既存の設定。一時的な引き上げを含む有効な値）と、今日すでに使った解析数 */
  workerDailyAiLimit: number;
  aiCallsToday: number;
}

export interface ResolvedControls {
  limits: AgentLimits;
  throttle: ThrottleOptions;
  maxAnalyses: number;
  maxFollowDepth: number;
  maxRuns: number;
  /** この調査で使える解析の残り枠（既存の1日の解析上限の残りと、1回の上限の小さい方） */
  analysisRemaining: number;
}

export type ControlsDecision = { ok: true; controls: ResolvedControls } | { ok: false; reason: string; kind: "runs" | "cost" | "analysis" };

export function resolveControls(u: DailyUsage, o: { mode: "dry_run" | "execute"; realApi: boolean; blockedHosts?: string[] }): ControlsDecision {
  const C = FIXED_CONTROLS;
  if (u.runsToday >= C.maxRunsPerDay) return { ok: false, kind: "runs", reason: `1日の調査回数の上限（${C.maxRunsPerDay}回）に達しています。明日以降に実行してください` };
  const costLeft = C.maxCostPerDayJpy - u.costTodayJpy;
  if (o.realApi && costLeft <= 0) return { ok: false, kind: "cost", reason: `1日の費用の上限（${C.maxCostPerDayJpy}円）に達しています` };
  const analysisLeft = Math.max(0, u.workerDailyAiLimit - u.aiCallsToday);
  // 解析は既存の1日の解析上限の残りの範囲でだけ行う（残りが無ければ解析なしの調査＝取得・照合・情報源の評価だけ）
  const maxAnalyses = Math.min(C.maxAnalysesPerRun, analysisLeft);
  return {
    ok: true,
    controls: {
      limits: { ...DEFAULT_LIMITS, maxSteps: C.maxSteps, maxFetches: C.maxFetches, maxSearches: C.maxSearches, maxCostJpy: o.realApi ? Math.min(C.maxCostPerRunJpy, Math.max(0, costLeft)) : C.maxCostPerRunJpy, maxMs: C.maxMs },
      throttle: { perHostMax: C.perHostMax, minIntervalMs: C.minIntervalMs, blockedHosts: o.blockedHosts ?? [] },
      maxAnalyses,
      maxFollowDepth: C.maxFollowDepth,
      maxRuns: C.maxRunsPerDay,
      analysisRemaining: analysisLeft,
    },
  };
}

/** 前回までの失敗の記録から、しばらく避ける情報源（ホスト）を決める。制限・ログインを回避せず、止めて復旧を待つ */
export function backoffHosts(history: { host: string; failures: number; lastFailKind?: string; lastFailAt?: string }[], now: Date): string[] {
  const out: string[] = [];
  for (const h of history) {
    if (h.failures < FIXED_CONTROLS.failuresBeforeBackoff) continue;
    const at = h.lastFailAt ? new Date(h.lastFailAt).getTime() : now.getTime();
    if (now.getTime() - at <= FIXED_CONTROLS.backoffDays * 86_400_000) out.push(h.host);
  }
  return out;
}
