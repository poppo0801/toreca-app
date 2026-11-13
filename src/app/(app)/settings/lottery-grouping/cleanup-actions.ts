"use server";

import { isLotteryGroupingEnabled } from "@/lib/agent/lottery-grouping/flags";
import { listRecentlyArchived, listSelectCleanup, resolveSelectCleanup, restoreArchived, type CleanupDecision, type CleanupView } from "@/lib/server/agent/select-cleanup-service";
import { currentHouseholdId, setLotteryForm, type Db } from "@/lib/server/lottery-service";
import { createClient } from "@/lib/supabase/server";

/**
 * 店舗選択式の二重登録の整理の操作（Stage 8F-7）。**開発環境（TOREMANE_ENV=local）でのみ動く**（本番では拒否され、DBにも触れない）。
 * 利用者の操作でだけ動き、応募の記録があるカードは退避しない。退避は物理削除ではなく、元に戻せる。
 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const DEV_ONLY = "この操作は開発環境でのみ使えます";
type Archived = { id: string; storeName: string; products: string; archivedAt: string };

async function ctx(): Promise<{ db: Db; householdId: string; actor: string | null } | null> {
  try {
    const db = (await createClient()) as unknown as Db;
    const { data } = await db.auth.getUser();
    if (!data.user) return null;
    const householdId = await currentHouseholdId(db);
    if (!householdId) return null;
    const { data: p } = await db.from("profiles").select("id").eq("household_id", householdId).order("sort_order").limit(1);
    return { db, householdId, actor: (p?.[0]?.id as string | undefined) ?? null };
  } catch {
    return null;
  }
}

/** 整理候補の一覧（読み取りのみ）と、最近退避した抽選（元に戻す対象） */
export async function listSelectCleanupAction(): Promise<R<{ candidates: CleanupView[]; archived: Archived[] }>> {
  if (!isLotteryGroupingEnabled()) return { ok: false, error: DEV_ONLY };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  return { ok: true, candidates: await listSelectCleanup(c.db, c.householdId), archived: await listRecentlyArchived(c.db, c.householdId) };
}

/** 整理する（記録の無いカードを退避）／別の抽選として残す／店舗選択式として扱う */
export async function resolveSelectCleanupAction(input: { key: string; decision: CleanupDecision }): Promise<R<{ changed: string[]; skippedProtected: string[] }>> {
  if (!isLotteryGroupingEnabled()) return { ok: false, error: DEV_ONLY };
  if (!["consolidate", "keep_separate", "mark_select"].includes(input?.decision) || typeof input?.key !== "string") return { ok: false, error: "リクエストが不正です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await resolveSelectCleanup(c.db, c.householdId, input, c.actor);
  return r.ok ? { ok: true, changed: r.changed, skippedProtected: r.skippedProtected } : { ok: false, error: r.error };
}

/** 整理（退避）の取り消し */
export async function restoreArchivedAction(id: string): Promise<R> {
  if (!isLotteryGroupingEnabled()) return { ok: false, error: DEV_ONLY };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await restoreArchived(c.db, c.householdId, id, c.actor);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** 手動の分類を解除（誤操作・誤判定からの復旧）。構造からの判別に戻る */
export async function clearLotteryFormAction(ids: string[]): Promise<R> {
  if (!isLotteryGroupingEnabled()) return { ok: false, error: DEV_ONLY };
  if (!Array.isArray(ids)) return { ok: false, error: "リクエストが不正です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  for (const id of ids.slice(0, 50)) {
    const r = await setLotteryForm(c.db, id, null, c.actor);
    if (!r.ok) return { ok: false, error: r.error };
  }
  return { ok: true };
}
