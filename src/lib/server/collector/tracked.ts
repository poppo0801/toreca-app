import "server-only";
import type { LotteryInput } from "@/lib/lottery-input";
import type { Tracking, TrackedLite } from "@/lib/collector/tracking";
import type { Db } from "@/lib/server/lottery-service";

/** 追跡中の抽選予告（自動再調査の保留で、追跡情報を持つ候補）を読み込む */
export async function loadTracked(db: Db, householdId: string): Promise<TrackedLite[]> {
  const { data } = await db
    .from("collection_candidates")
    .select("id,draft,created_at")
    .eq("household_id", householdId)
    .eq("status", "pending")
    .eq("job_state", "review")
    .eq("triage", "auto_retry")
    .eq("kind", "new")
    .limit(300);
  const out: TrackedLite[] = [];
  for (const r of data ?? []) {
    const d = r.draft as { input?: LotteryInput; tracking?: Tracking } | null;
    if (d?.input && d.tracking) out.push({ id: r.id, input: d.input, tracking: d.tracking, created_at: r.created_at });
  }
  return out;
}
