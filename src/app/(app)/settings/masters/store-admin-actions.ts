"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { deleteStore, mergeStores, storeReferences } from "@/lib/server/store-admin-service";
import type { StoreRefCounts } from "@/lib/store-admin";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";

/** 店舗マスターの削除・統合（Stage 7S）。ログイン必須・自世帯のみ（RLS と DB 関数の世帯確認）。 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function ctx(): Promise<Db | null> {
  try {
    const db = (await createClient()) as unknown as Db;
    const { data } = await db.auth.getUser();
    if (!data.user) return null;
    return (await currentHouseholdId(db)) ? db : null;
  } catch {
    return null;
  }
}
const NEED = { ok: false as const, error: "ログインが必要です" };

export async function storeReferencesAction(storeId: string): Promise<R<{ counts: StoreRefCounts }>> {
  const db = await ctx();
  if (!db) return NEED;
  const r = await storeReferences(db, storeId);
  return r.ok ? { ok: true, counts: r.value } : { ok: false, error: r.error };
}

export async function deleteStoreAction(storeId: string): Promise<R> {
  const db = await ctx();
  if (!db) return NEED;
  const r = await deleteStore(db, storeId);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/settings/masters");
  return { ok: true };
}

export async function mergeStoresAction(fromId: string, intoId: string, actor: string | null): Promise<R<{ lotteries: number }>> {
  const db = await ctx();
  if (!db) return NEED;
  const r = await mergeStores(db, fromId, intoId, actor);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/settings/masters");
  return { ok: true, lotteries: r.value.lotteries };
}
