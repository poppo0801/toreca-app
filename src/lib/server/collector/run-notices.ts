import "server-only";
import { pickNotice, summarizeRun, type RunLite, type RunSummary } from "@/lib/collector/run-summary";
import type { ManualItem } from "@/lib/collector/manual-items";
import { loadManualItems } from "@/lib/server/collector/manual-items";
import type { Db } from "@/lib/server/lottery-service";

/** 収集結果の通知用の読み込み（Stage 5S-B）。既存の通知（ベル）と同じ画面に統合し、専用の通知システムは持たない */
export interface RunNotices {
  summaries: RunSummary[];
  /** 起動時に表示する実行（無ければ null）と、表示後に確認済みにする実行 */
  notice: RunSummary | null;
  ackIds: string[];
  /** 未対応の要手動確認（ポップアップを閉じても、対応するまで残る） */
  manual: ManualItem[];
}

const RUN_COLS = "id,trigger,status,started_at,finished_at,new_count,registered_count,ai_calls";

export async function loadRunNotices(db: Db, userId: string | null, limit = 8): Promise<RunNotices> {
  const manual = await loadManualItems(db, new Date(), 60, true).catch(() => [] as ManualItem[]);
  const runs = ((await db.from("collection_runs").select(RUN_COLS).eq("phase", "collect").order("started_at", { ascending: false }).limit(limit)).data ?? []) as unknown as RunLite[];
  if (runs.length === 0) return { summaries: [], notice: null, ackIds: [], manual };
  const ids = runs.map((r) => r.id);
  const [cands, acks] = await Promise.all([
    db.from("collection_candidates").select("discovered_run_id,status,job_state,fail_kind,ai_calls,cost_jpy").in("discovered_run_id", ids).limit(5000),
    userId ? db.from("collection_run_acks").select("run_id").eq("user_id", userId).in("run_id", ids) : Promise.resolve({ data: [] as { run_id: string }[] }),
  ]);
  const byRun = new Map<string, NonNullable<typeof cands.data>>();
  for (const c of cands.data ?? []) {
    const k = c.discovered_run_id as string;
    byRun.set(k, [...(byRun.get(k) ?? []), c]);
  }
  const summaries = runs.map((r) => summarizeRun(r, (byRun.get(r.id) ?? []) as never));
  const acked = new Set((acks.data ?? []).map((a) => a.run_id));
  const p = pickNotice(summaries, acked);
  return { summaries, notice: p.show, ackIds: p.ackIds, manual };
}

export async function ackRuns(db: Db, householdId: string, userId: string, runIds: string[]): Promise<void> {
  if (runIds.length === 0) return;
  await db.from("collection_run_acks").upsert(runIds.map((run_id) => ({ run_id, user_id: userId, household_id: householdId })) as never, { onConflict: "run_id,user_id", ignoreDuplicates: true });
}
