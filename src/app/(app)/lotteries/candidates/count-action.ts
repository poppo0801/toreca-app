"use server";

import { closedReviewIds } from "@/lib/server/collector/closed-ids";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

/** 抽選候補（自動収集の確認待ち）の未処理件数。応募受付が終了した候補は数えない（設定画面の件数と同じ基準）。未ログイン・取得失敗は 0 */
export async function reviewCandidateCountAction(): Promise<number> {
  if (!isSupabaseMode) return 0;
  try {
    const db = await createClient();
    const { data: auth } = await db.auth.getUser();
    if (!auth.user) return 0;
    const [{ count }, closed] = await Promise.all([db.from("collection_candidates").select("id", { count: "exact", head: true }).eq("job_state", "review").neq("status", "auto_registered"), closedReviewIds(db as never, new Date())]);
    return Math.max(0, (count ?? 0) - closed.size);
  } catch {
    return 0;
  }
}
