/**
 * 本番シャドー用の非同期ワーカーの許可判定（Stage 10K）。**既存の 9H 系のローカル限定フラグ（`TOREMANE_ENV=local`）を解除しない**。
 * ワーカー専用の独立した許可で、既定はすべて OFF（本番でも環境変数を立てなければ何も起きない）。
 *  - SHADOW_WORKER=on                       … ワーカーの実行を許可（これが無ければ何もしない）
 *  - SHADOW_WORKER_KILL=1|on                … 緊急停止（環境変数。DB側の settings.enabled=false は再デプロイ不要で、より即時）
 *  - 本番（NODE_ENV=production または VERCEL 系）では、さらに SHADOW_WORKER_PRODUCTION_APPROVED=yes が要る（本番有効化の承認を表す2つ目のスイッチ）
 *  - SHADOW_ANTHROPIC_API_KEY               … シャドー専用のAPIキー（あれば優先）。**開発用（AGENT_/JUDGMENT_）のキーは使わない・流用しない**。
 *  - SHADOW_REUSE_EXISTING_KEY=allow        … 専用キーが無いとき、本番の既存キー（ANTHROPIC_API_KEY）を再利用してよい（利用者の明示承認を表すスイッチ。新規キーの発行を避けるため）。
 *    費用の安全は「キーの分離」ではなく、DBの予算（日次・月次・通算・1件・試行期間・直列化ロック。shadow_settings）が担う。再利用中は、API側の請求は他機能の利用と合算される点に注意。無ければ実AIは呼ばない
 *  - SHADOW_ENQUEUE=on                      … 通常収集からの投入を許可（DB側 enqueue_enabled と両方が要る）
 * この Stage では本番で有効化しない・本番専用キーを設定しない。
 */
type Env = Record<string, string | undefined>;
const on = (v: string | undefined): boolean => v === "on" || v === "1" || v === "yes";

export interface ShadowWorkerPermission {
  allowed: boolean;
  reason: "allowed" | "off" | "killed" | "production_not_approved";
  hasKey: boolean;
}

/** シャドーが使うAPIキー。専用キー → （SHADOW_REUSE_EXISTING_KEY=allow のときだけ）既存キー。どちらも無ければ null。値は呼び出し側で扱い、記録・表示しない */
export function shadowApiKey(env: Env = process.env): { key: string; source: "dedicated" | "existing" } | null {
  const d = env.SHADOW_ANTHROPIC_API_KEY;
  if (typeof d === "string" && d.length > 20) return { key: d, source: "dedicated" };
  const e = env.ANTHROPIC_API_KEY;
  if (env.SHADOW_REUSE_EXISTING_KEY === "allow" && typeof e === "string" && e.length > 20) return { key: e, source: "existing" };
  return null;
}

export function shadowWorkerPermission(env: Env = process.env): ShadowWorkerPermission {
  const hasKey = shadowApiKey(env) !== null;
  if (!on(env.SHADOW_WORKER)) return { allowed: false, reason: "off", hasKey };
  if (on(env.SHADOW_WORKER_KILL)) return { allowed: false, reason: "killed", hasKey };
  const prod = env.NODE_ENV === "production" || Boolean(env.VERCEL) || Boolean(env.VERCEL_ENV);
  if (prod && env.SHADOW_WORKER_PRODUCTION_APPROVED !== "yes") return { allowed: false, reason: "production_not_approved", hasKey };
  return { allowed: true, reason: "allowed", hasKey };
}

/** 通常収集からの投入を許可するか（環境変数側。DB側の enqueue_enabled とは別に両方が必要）。既定 OFF */
export function shadowEnqueueAllowed(env: Env = process.env): boolean {
  if (on(env.SHADOW_WORKER_KILL)) return false;
  const prod = env.NODE_ENV === "production" || Boolean(env.VERCEL) || Boolean(env.VERCEL_ENV);
  if (prod && env.SHADOW_WORKER_PRODUCTION_APPROVED !== "yes") return false;
  return on(env.SHADOW_ENQUEUE);
}
