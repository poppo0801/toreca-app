"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { MemoInput, MemoRow } from "@/lib/collector/memos";
import { createClient } from "@/lib/supabase/server";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";
import { createMemo, listMemos, runMemoPass, setMemoState } from "@/lib/server/collector/memos";

export type MemoActionResult = { ok: true } | { ok: false; error: string };

async function ctx(): Promise<{ db: Db; householdId: string } | null> {
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;
  const householdId = await currentHouseholdId(db);
  return householdId ? { db, householdId } : null;
}

export async function listMemosAction(): Promise<MemoRow[]> {
  const c = await ctx();
  return c ? listMemos(c.db) : [];
}

export async function createMemoAction(input: MemoInput, actor: string | null): Promise<MemoActionResult> {
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const res = await createMemo(c.db, c.householdId, actor, input);
  if (!res.ok) return res;
  // 登録直後に、既存の抽選・収集候補との照合だけ行う（取得を伴う調査は次回の収集、または「今すぐ再調査」）
  await runMemoPass({ db: c.db, householdId: c.householdId, now: new Date() }, { ids: [res.id], force: true, noFetch: true }).catch(() => undefined);
  revalidatePath("/lotteries");
  return { ok: true };
}

export async function setMemoStateAction(id: string, state: "withdrawn" | "unsurveyed"): Promise<MemoActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const ok = await setMemoState(c.db, id, state);
  revalidatePath("/lotteries");
  return ok ? { ok: true } : { ok: false, error: "更新できませんでした" };
}

/** 今すぐ再調査（間隔にかかわらず1件だけ。参考URLがあれば取得する。取得できない場合は理由を表示する） */
export async function recheckMemoAction(id: string): Promise<MemoActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "不正な指定です" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  await runMemoPass({ db: c.db, householdId: c.householdId, now: new Date() }, { ids: [id], force: true });
  revalidatePath("/lotteries");
  return { ok: true };
}
