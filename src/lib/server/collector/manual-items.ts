import "server-only";
import { sortManual, toManualItem, type ManualItem, type ManualRow } from "@/lib/collector/manual-items";
import { isApplicationClosed } from "@/lib/collector/closed";
import type { Db } from "@/lib/server/lottery-service";

const COLS = "id,title,source_url,due_at,manual_reason,fail_kind,manual_since,draft,last_good";

/** 未対応の要手動確認（締切が近い順）。再試行で解決可能な一時的エラー（自動再調査中）は含めない。onlyNow=今すぐ確認（締切7日以内）だけ */
export async function loadManualItems(db: Db, now = new Date(), limit = 60, onlyNow = false): Promise<ManualItem[]> {
  const { data } = await db.from("collection_candidates").select(COLS).eq("triage", "manual").eq("manual_state", "open").limit(limit);
  const items = sortManual(((data ?? []) as unknown as ManualRow[]).filter((r) => !isApplicationClosed({ dueAt: r.due_at, draft: r.draft }, now)).map((r) => toManualItem(r, now)));
  return onlyNow ? items.filter((i) => i.group === "now") : items;
}

/** 設定画面用の3区分: 今すぐ確認/余裕あり・不明（要手動確認）、自動再調査中、終了・対象外・対応済み */
export async function loadManualGroups(db: Db, now = new Date()): Promise<{ open: ManualItem[]; retrying: ManualItem[]; closed: ManualItem[]; retryingCount: number }> {
  const [open, retry, closed] = await Promise.all([
    loadManualItems(db, now, 100),
    db.from("collection_candidates").select(`${COLS},triage_reason`, { count: "exact" }).eq("triage", "auto_retry").eq("job_state", "review").eq("status", "pending").order("due_at", { ascending: true, nullsFirst: false }).limit(30),
    db.from("collection_candidates").select(COLS).eq("triage", "manual").in("manual_state", ["resolved", "dismissed"]).order("manual_resolved_at", { ascending: false }).limit(10),
  ]);
  const all = (retry.data ?? []) as unknown as (ManualRow & { triage_reason: string | null })[];
  // 応募受付が終了した候補は通常の一覧・件数から外す（履歴は残す）
  const rows = all.filter((r) => !isApplicationClosed({ dueAt: r.due_at, draft: r.draft }, now));
  return {
    open,
    retrying: sortManual(rows.map((r) => toManualItem({ ...r, manual_reason: r.triage_reason ?? "" }, now))),
    closed: ((closed.data ?? []) as unknown as ManualRow[]).map((r) => toManualItem(r, now)),
    retryingCount: Math.max(0, (retry.count ?? all.length) - (all.length - rows.length)),
  };
}
