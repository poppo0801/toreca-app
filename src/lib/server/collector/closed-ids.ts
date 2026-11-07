import "server-only";
import { isApplicationClosed } from "@/lib/collector/closed";
import type { Db } from "@/lib/server/lottery-service";

/** 確認待ち（job_state=review）のうち、応募受付が終了した候補のID。通常の一覧・件数から外すために使う（候補は削除しない） */
export async function closedReviewIds(db: Db, now = new Date()): Promise<Set<string>> {
  const { data } = await db.from("collection_candidates").select("id,due_at,draft").eq("job_state", "review").eq("status", "pending").limit(2000);
  const ids = new Set<string>();
  for (const r of data ?? []) if (isApplicationClosed({ dueAt: r.due_at, draft: r.draft }, now)) ids.add(r.id);
  return ids;
}
