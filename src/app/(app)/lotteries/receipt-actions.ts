"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { loadBoxReceipts, recordBoxReceipt, type BoxReceiptRow } from "@/lib/server/box-service";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";

/** BOX受取のシュリンク状態（Stage 6L）。ログイン必須・自世帯のみ（RLS）。 */
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

export async function loadBoxReceiptsAction(purchaseItemIds: string[]): Promise<R<{ receipts: BoxReceiptRow[] }>> {
  const db = await ctx();
  if (!db) return { ok: false, error: "ログインが必要です" };
  const r = await loadBoxReceipts(db, purchaseItemIds);
  return r.ok ? { ok: true, receipts: r.value } : { ok: false, error: r.error };
}

export async function recordBoxReceiptAction(purchaseItemId: string, receivedOn: string, states: { state: string; quantity: number }[], actor: string | null): Promise<R> {
  const db = await ctx();
  if (!db) return { ok: false, error: "ログインが必要です" };
  const r = await recordBoxReceipt(db, purchaseItemId, receivedOn, states, actor);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/collection");
  return { ok: true };
}
