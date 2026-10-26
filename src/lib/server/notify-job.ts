import { runNotificationCycle, type CycleResult } from "@/lib/server/notification-service";
import type { Db } from "@/lib/server/lottery-service";
import type { PushSender } from "@/lib/server/push";

export type JobOutcome =
  | { ok: true; skipped: false; runId: string | null; result: CycleResult }
  | { ok: true; skipped: true; reason: "already_running" }
  | { ok: false; errorCode: string };

/** 実行中とみなす時間。これを超えて running のままの行は異常終了として閉じる。 */
const RUNNING_WINDOW_MS = 5 * 60_000;
const ABANDONED_MS = 10 * 60_000;
const KEEP_DAYS = 30;

/**
 * 通知ジョブ（記録つき）。定期実行の呼び出しごとに notification_job_runs へ状態・件数・所要時間を残す。
 *  - 例外は種別名のみ記録（メッセージ・個人情報は残さない）。
 *  - 直前の実行がまだ走っている場合は重複起動を避けてスキップ（配信自体も冪等だが無駄な再計算を避ける）。
 * db は service_role のクライアント。
 */
export async function runNotifyJob(
  db: Db,
  send: PushSender,
  opts: { now?: Date; trigger?: "cron" | "manual"; onlyHousehold?: string; maxSends?: number } = {},
): Promise<JobOutcome> {
  const now = opts.now ?? new Date();

  // 異常終了(クラッシュ・タイムアウト)した古い running を閉じ、古い履歴を整理
  await db
    .from("notification_job_runs")
    .update({ status: "error", error_code: "abandoned", finished_at: now.toISOString() })
    .eq("status", "running")
    .lt("started_at", new Date(now.getTime() - ABANDONED_MS).toISOString());
  await db.from("notification_job_runs").delete().lt("started_at", new Date(now.getTime() - KEEP_DAYS * 86400_000).toISOString());

  const { data: running } = await db
    .from("notification_job_runs")
    .select("id")
    .eq("status", "running")
    .gt("started_at", new Date(now.getTime() - RUNNING_WINDOW_MS).toISOString())
    .limit(1);
  if (running && running.length > 0) return { ok: true, skipped: true, reason: "already_running" };

  const { data: run } = await db
    .from("notification_job_runs")
    .insert({ trigger: opts.trigger ?? "cron", started_at: now.toISOString() })
    .select("id")
    .single();
  const runId = run?.id ?? null;
  const t0 = Date.now();

  try {
    const result = await runNotificationCycle(db, send, now, opts.onlyHousehold, opts.maxSends);
    if (runId) {
      await db
        .from("notification_job_runs")
        .update({
          status: "ok",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - t0,
          planned: result.planned,
          sent: result.sent,
          failed: result.failed,
          suppressed: result.suppressed,
          no_device: result.noDevice,
          duplicates: result.duplicates,
        })
        .eq("id", runId);
    }
    return { ok: true, skipped: false, runId, result };
  } catch (e) {
    const errorCode = (e instanceof Error ? e.name : "unknown").slice(0, 60) || "unknown";
    console.error("notify job failed:", errorCode);
    if (runId) {
      await db
        .from("notification_job_runs")
        .update({ status: "error", finished_at: new Date().toISOString(), duration_ms: Date.now() - t0, error_code: errorCode })
        .eq("id", runId);
    }
    return { ok: false, errorCode };
  }
}
