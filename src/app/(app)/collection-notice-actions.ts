"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";
import { ackRuns, EMPTY_BOOKMARKS, loadRunNotices, type RunNotices } from "@/lib/server/collector/run-notices";
import { closeBookmark, markBookmarksShown } from "@/lib/server/collector/bookmark-track";

const EMPTY: RunNotices = { summaries: [], notice: null, ackIds: [], manual: [], bookmarks: EMPTY_BOOKMARKS };

/**
 * 起動時の収集結果の通知と、直近の収集の履歴（デモモード・未ログインでは空）。
 * 起動時ポップアップの対象は、収集設定に固定IDで指定されたプロフィール（collection_settings.result_notice_profile_id）だけ。
 * 表示名ではなくIDで判定するので、名前を変えても対象は変わらない。対象外のプロフィールには何も返さない（通常の設定画面・ベルの履歴は別の経路で見られる）。
 */
export async function getRunNoticesAction(activeProfileId?: string): Promise<RunNotices> {
  try {
    if (!activeProfileId || !z.uuid().safeParse(activeProfileId).success) return EMPTY;
    const db = (await createClient()) as unknown as Db;
    const { data: auth } = await db.auth.getUser();
    if (!auth.user) return EMPTY;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列は生成型に無い
    const { data: s } = await (db as any).from("collection_settings").select("result_notice_profile_id").limit(1).maybeSingle();
    if (!s || s.result_notice_profile_id !== activeProfileId) return EMPTY;
    return await loadRunNotices(db, auth.user.id);
  } catch {
    return EMPTY;
  }
}

/** 確認済みにする（自分の分だけ。同じ結果を繰り返し表示しない） */
export async function ackRunNoticesAction(runIds: string[]): Promise<{ ok: boolean }> {
  const ids = z.array(z.uuid()).max(20).safeParse(runIds);
  if (!ids.success) return { ok: false };
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  const hid = auth.user ? await currentHouseholdId(db) : null;
  if (!auth.user || !hid) return { ok: false };
  await ackRuns(db, hid, auth.user.id, ids.data);
  return { ok: true };
}

/** 起動時ポップアップに表示したブックマークを「表示済み」にする（再起動のたびに同じ新規として繰り返さない） */
export async function ackBookmarksShownAction(ids: string[]): Promise<{ ok: boolean }> {
  const p = z.array(z.uuid()).max(200).safeParse(ids);
  if (!p.success) return { ok: false };
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  const hid = auth.user ? await currentHouseholdId(db) : null;
  if (!auth.user || !hid) return { ok: false };
  await markBookmarksShown(db, hid, p.data);
  return { ok: true };
}

/** 利用者が「対象外」「調査終了」を選ぶ（未解決一覧から外れ、自動再調査も止まる。履歴は残る） */
export async function closeBookmarkAction(id: string, kind: "excluded" | "investigation_ended"): Promise<{ ok: boolean; error?: string }> {
  const p = z.object({ id: z.uuid(), kind: z.enum(["excluded", "investigation_ended"]) }).safeParse({ id, kind });
  if (!p.success) return { ok: false, error: "リクエストが不正です" };
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  const hid = auth.user ? await currentHouseholdId(db) : null;
  if (!auth.user || !hid) return { ok: false, error: "ログインが必要です" };
  const ok = await closeBookmark(db, hid, p.data.id, p.data.kind);
  return ok ? { ok: true } : { ok: false, error: "更新できませんでした" };
}
