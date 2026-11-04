"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";
import { ackRuns, loadRunNotices, type RunNotices } from "@/lib/server/collector/run-notices";

const EMPTY: RunNotices = { summaries: [], notice: null, ackIds: [], manual: [] };

/** 起動時の収集結果の通知と、直近の収集の履歴（デモモード・未ログインでは空） */
export async function getRunNoticesAction(): Promise<RunNotices> {
  try {
    const db = (await createClient()) as unknown as Db;
    const { data: auth } = await db.auth.getUser();
    if (!auth.user) return EMPTY;
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
