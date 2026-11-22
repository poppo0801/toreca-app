/**
 * 新AI判断のシャドーモード設定（Stage 10F）。**初期状態OFF**。旧方式が唯一の正式な判断・登録経路で、シャドーは比較用の判断を記録するだけ。
 * 有効になる条件（すべて必要）:
 *   TOREMANE_ENV=local（開発環境）・NODE_ENV≠production・VERCEL 系の環境変数なし・SHADOW_JUDGMENT=on・緊急停止（SHADOW_JUDGMENT_KILL）がオンでない
 * 実AIでのシャドー（SHADOW_JUDGMENT_MODE=real）は**未承認**のため、このStageでは常に無効（実原文の送信・課金は Phase2 承認ゲート C・E が前提）。
 * 緊急停止・設定の変更は呼び出しごとに環境変数を読み直すため、プロセスを再起動しなくても即時に反映される。
 */
type Env = Record<string, string | undefined>;

export interface ShadowConfig {
  enabled: boolean;
  /** 無効のときの理由（ログ・テスト用。機微情報を含まない） */
  reason: "enabled" | "off" | "not_local" | "production_env" | "killed" | "real_mode_unapproved";
  mode: "mock";
  /** 一定時間内に実行してよい最大件数 */
  maxPerWindow: number;
  windowMs: number;
  /** 1件の最大待ち時間（ミリ秒）。超えたらシャドーを打ち切り、旧方式は何も待たない */
  timeoutMs: number;
  /** シャドー全体の費用上限（円）と、1件の上限 */
  budgetCapJpy: number;
  perCaseCapJpy: number;
  /** 同時に実行してよい件数 */
  maxConcurrent: number;
}

const num = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && v != null && v !== "" ? Math.min(max, Math.max(min, n)) : def;
};

export function shadowConfig(env: Env = process.env): ShadowConfig {
  const limits = {
    mode: "mock" as const,
    maxPerWindow: Math.floor(num(env.SHADOW_JUDGMENT_MAX_PER_HOUR, 20, 0, 200)),
    windowMs: 3_600_000,
    timeoutMs: Math.floor(num(env.SHADOW_JUDGMENT_TIMEOUT_MS, 20_000, 100, 60_000)),
    budgetCapJpy: num(env.SHADOW_JUDGMENT_BUDGET_JPY, 5, 0, 50),
    perCaseCapJpy: num(env.SHADOW_JUDGMENT_PER_CASE_JPY, 2, 0, 5),
    maxConcurrent: Math.floor(num(env.SHADOW_JUDGMENT_MAX_CONCURRENT, 1, 1, 3)),
  };
  const off = (reason: ShadowConfig["reason"]): ShadowConfig => ({ ...limits, enabled: false, reason });
  if (env.SHADOW_JUDGMENT !== "on") return off("off");
  if (env.SHADOW_JUDGMENT_KILL === "1" || env.SHADOW_JUDGMENT_KILL === "on") return off("killed");
  if (env.TOREMANE_ENV !== "local") return off("not_local");
  if (env.NODE_ENV === "production" || env.VERCEL || env.VERCEL_ENV) return off("production_env");
  if (env.SHADOW_JUDGMENT_MODE === "real") return off("real_mode_unapproved");
  return { ...limits, enabled: true, reason: "enabled" };
}
