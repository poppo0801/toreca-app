import "server-only";
import { rebuildQueued } from "@/lib/collector/queued";
import type { Db } from "@/lib/server/lottery-service";

/** 利用者の操作で除外した候補の印（取り消しで戻せるのは、この印の付いたものだけ） */
export const USER_EXCLUDED = "利用者が除外しました";

export interface ExcludeSnapshot {
  id: string;
  prev: Record<string, unknown>;
}

async function snapshot(db: Db, ids: string[]): Promise<ExcludeSnapshot[]> {
  const { data } = await db.from("collection_candidates").select("id,status,job_state,triage,triage_reason,manual_state,reasons,resolved_at,completed_at,next_run_at").in("id", ids).neq("status", "auto_registered");
  return (data ?? []).map((r) => ({ id: r.id, prev: { status: r.status, job_state: r.job_state, triage: r.triage, triage_reason: r.triage_reason ?? "", manual_state: r.manual_state, reasons: r.reasons, resolved_at: r.resolved_at, completed_at: r.completed_at, next_run_at: r.next_run_at } }));
}

/**
 * 選択した候補だけを除外する（収集元全体の除外ルールは作らない。物理削除しない）。登録済みの候補は除外しない。
 * 成功・失敗の件数と、取り消し用の直前の状態を返す。
 */
export async function excludeCandidates(db: Db, ids: string[]): Promise<{ ok: true; excluded: number; failed: number; prev: ExcludeSnapshot[] } | { ok: false }> {
  const prev = await snapshot(db, ids);
  const { data, error } = await db
    .from("collection_candidates")
    .update({ status: "excluded", job_state: "skipped", reasons: [USER_EXCLUDED], resolved_at: new Date().toISOString(), lease_until: null, locked_by: null })
    .in("id", ids)
    .neq("status", "auto_registered")
    .select("id");
  if (error) return { ok: false };
  const done = new Set((data ?? []).map((r) => r.id));
  return { ok: true, excluded: done.size, failed: ids.length - done.size, prev: prev.filter((x) => done.has(x.id)) };
}

/** 除外の取り消し。利用者が除外した候補だけを直前の状態へ戻す（他の処理で変わった候補には触れない） */
export async function undoExclude(db: Db, items: ExcludeSnapshot[]): Promise<{ restored: number; failed: number }> {
  const allowed = ["status", "job_state", "triage", "triage_reason", "manual_state", "reasons", "resolved_at", "completed_at", "next_run_at", "lottery_id"];
  let restored = 0;
  let failed = 0;
  for (const it of items) {
    const patch = Object.fromEntries(Object.entries(it.prev).filter(([k]) => allowed.includes(k)));
    const { data, error } = await db.from("collection_candidates").update(patch as never).eq("id", it.id).in("status", ["excluded", "duplicate"]).contains("reasons", [USER_EXCLUDED]).select("id");
    if (error || (data ?? []).length === 0) failed++;
    else restored++;
  }
  return { restored, failed };
}

/** 選択した候補を再調査（再解析待ち）に戻す。一覧のカード・保存済みのX投稿情報は引き継ぐ。成功・失敗の件数を返す */
export async function requeueCandidates(db: Db, ids: string[]): Promise<{ requeued: number; failed: number }> {
  let requeued = 0;
  let failed = 0;
  for (const id of ids) {
    const { data: c } = await db.from("collection_candidates").select("id,draft,status,source_url,dedupe_key,title").eq("id", id).maybeSingle();
    if (!c || c.status === "auto_registered" || !c.source_url) {
      failed++;
      continue;
    }
    const prior = (c.draft as object | null) ?? {};
    const queued = rebuildQueued(prior, { kind: c.dedupe_key.startsWith("x:") ? "x_oembed" : "web_page", url: c.source_url, sourceName: "再調査", reason: "manual_reanalyze", changed: true, fallbackTitle: c.title });
    const { error } = await db.from("collection_candidates").update({ job_state: "pending", status: "pending", attempts: 0, next_run_at: null, reasons: ["再調査待ち"], draft: { ...prior, queued } as never, lease_until: null, locked_by: null }).eq("id", id);
    if (error) failed++;
    else requeued++;
  }
  return { requeued, failed };
}
