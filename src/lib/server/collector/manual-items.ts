import "server-only";
import { sortManual, toManualItem, type ManualItem, type ManualRow } from "@/lib/collector/manual-items";
import type { Db } from "@/lib/server/lottery-service";

/** 未対応の要手動確認（締切が近い順）。再試行で解決可能な一時的エラー（自動再調査中）は含めない */
export async function loadManualItems(db: Db, now = new Date(), limit = 60): Promise<ManualItem[]> {
  const { data } = await db
    .from("collection_candidates")
    .select("id,title,source_url,due_at,manual_reason,fail_kind,manual_since,draft,last_good")
    .eq("triage", "manual")
    .eq("manual_state", "open")
    .limit(limit);
  return sortManual(((data ?? []) as unknown as ManualRow[]).map((r) => toManualItem(r, now)));
}
