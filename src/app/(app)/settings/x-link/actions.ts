"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runBookmarkSync } from "@/lib/server/collector/bookmarks";
import { xBudgetLeft } from "@/lib/server/collector/x-rich";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";
import { adminDb, disconnect, loadLink, oauthConfig } from "@/lib/server/x-oauth-server";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export type XLinkResult = { ok: true; message: string } | { ok: false; error: string };

/** ログイン中のユーザーと、その世帯（RLS）。トークンに触れる処理は、ここで世帯を確認してから service_role で行う */
async function ctx(): Promise<{ db: Db; householdId: string } | null> {
  if (!isSupabaseMode) return null;
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;
  const householdId = await currentHouseholdId(db);
  return householdId ? { db, householdId } : null;
}

/** 自動収集のON/OFF。ONにできるのは、連携済み・認証有効で、収集設定のX API利用と月額予算が有効なときだけ（有料のため明示的に許可する） */
export async function setAutoSyncAction(enabled: boolean): Promise<XLinkResult> {
  const p = z.boolean().safeParse(enabled);
  if (!p.success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const link = await loadLink(c.db, c.householdId);
  if (!link) return { ok: false, error: "Xアカウントが連携されていません" };
  if (enabled) {
    if (link.status !== "active") return { ok: false, error: "認証が切れています。再連携してください" };
    const b = await xBudgetLeft(c.db, c.householdId);
    if (!b.enabled) return { ok: false, error: "先に「抽選情報の自動収集」でX APIの利用を有効にし、月額予算を設定してください" };
    if (b.remaining < 4) return { ok: false, error: "X APIの今月の予算に余裕がありません" };
  }
  // 利用者が変更できるのは auto_sync 列だけ（列の権限とRLSで世帯内に限る）
  const { error } = await (c.db as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<{ error: unknown }> } } }).from("x_bookmark_links").update({ auto_sync: enabled }).eq("id", link.id);
  revalidatePath("/settings/x-link");
  return error ? { ok: false, error: "更新できませんでした" } : { ok: true, message: enabled ? "自動収集をONにしました" : "自動収集をOFFにしました" };
}

/** 今すぐ同期（手動）。予算・設定・認証がそろっていなければX APIを呼ばない */
export async function syncNowAction(): Promise<XLinkResult> {
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const link = await loadLink(c.db, c.householdId);
  if (!link) return { ok: false, error: "Xアカウントが連携されていません" };
  if (link.last_synced_at && Date.now() - new Date(link.last_synced_at).getTime() < 60_000) return { ok: false, error: "直前に同期しました。1分ほど空けてください" };
  const admin = adminDb();
  if (!admin) return { ok: false, error: "サーバーの設定が不足しています" };
  const r = await runBookmarkSync({ db: admin, householdId: c.householdId, trigger: "manual" });
  revalidatePath("/settings/x-link");
  revalidatePath("/settings/collection");
  return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.message };
}

/** 連携解除: Xのトークンを失効・削除し、自動収集を止める。収集済みの候補・抽選・応募・購入・メモは変更しない */
export async function disconnectAction(): Promise<XLinkResult> {
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const admin = adminDb();
  if (!admin) return { ok: false, error: "サーバーの設定が不足しています" };
  const r = await disconnect(admin, oauthConfig(), c.householdId);
  revalidatePath("/settings/x-link");
  return r.ok ? { ok: true, message: r.revoked ? "連携を解除しました（Xの認証も失効しました）" : "連携を解除しました。Xの「連携アプリ」から権限を取り消すこともできます" } : { ok: false, error: "解除できませんでした" };
}
