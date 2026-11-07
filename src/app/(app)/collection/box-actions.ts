"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  addBoxPrices,
  addManualBox,
  adjustBox,
  reclassifyBox,
  importPurchaseItem,
  loadBoxCollection,
  loadProductStock,
  openBoxes,
  revertBoxOp,
  saveBoxSettings,
  updateBoxLot,
  type BoxCollectionData,
  type ManualBoxInput,
} from "@/lib/server/box-collection-service";
import { currentHouseholdId, type Db, type ServiceResult } from "@/lib/server/lottery-service";

/**
 * BOXコレクション（Stage 6M）の操作。ログイン必須・自世帯のみ（RLS と DB 関数の世帯確認）。
 * 在庫の増減は DB 関数（ロック・履歴の追記・操作ID）で行い、ここからは履歴を直接書かない。
 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function ctx(): Promise<{ db: Db; householdId: string } | null> {
  try {
    const db = (await createClient()) as unknown as Db;
    const { data } = await db.auth.getUser();
    if (!data.user) return null;
    const householdId = await currentHouseholdId(db);
    return householdId ? { db, householdId } : null;
  } catch {
    return null;
  }
}
const NEED_LOGIN = { ok: false, error: "ログインが必要です" } as const;
function done<T>(r: ServiceResult<T>): R<{ value: T }> {
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/collection");
  return { ok: true, value: r.value };
}

export async function loadBoxCollectionAction(): Promise<R<{ data: BoxCollectionData }>> {
  const c = await ctx();
  if (!c) return NEED_LOGIN;
  const r = await loadBoxCollection(c.db);
  return r.ok ? { ok: true, data: r.value } : { ok: false, error: r.error };
}

export async function loadProductStockAction(productId: string): Promise<R<{ stock: { shrink: number; no_shrink: number; unknown: number } }>> {
  const c = await ctx();
  if (!c) return NEED_LOGIN;
  const r = await loadProductStock(c.db, productId);
  return r.ok ? { ok: true, stock: r.value } : { ok: false, error: r.error };
}

export async function addManualBoxAction(input: ManualBoxInput, actor: string | null) {
  const c = await ctx();
  return c ? done(await addManualBox(c.db, c.householdId, input, actor)) : NEED_LOGIN;
}
export async function adjustBoxAction(input: Parameters<typeof adjustBox>[1], actor: string | null) {
  const c = await ctx();
  return c ? done(await adjustBox(c.db, input, actor)) : NEED_LOGIN;
}
export async function reclassifyBoxAction(input: Parameters<typeof reclassifyBox>[1], actor: string | null) {
  const c = await ctx();
  return c ? done(await reclassifyBox(c.db, input, actor)) : NEED_LOGIN;
}
export async function updateBoxLotAction(input: Parameters<typeof updateBoxLot>[1], actor: string | null) {
  const c = await ctx();
  return c ? done(await updateBoxLot(c.db, input, actor)) : NEED_LOGIN;
}
export async function openBoxesAction(input: Parameters<typeof openBoxes>[2], actor: string | null) {
  const c = await ctx();
  return c ? done(await openBoxes(c.db, c.householdId, input, actor)) : NEED_LOGIN;
}
export async function revertBoxOpAction(opId: string, actor: string | null) {
  const c = await ctx();
  return c ? done(await revertBoxOp(c.db, c.householdId, opId, actor)) : NEED_LOGIN;
}
export async function importPurchaseItemAction(purchaseItemId: string, actor: string | null) {
  const c = await ctx();
  return c ? done(await importPurchaseItem(c.db, purchaseItemId, actor)) : NEED_LOGIN;
}
export async function addBoxPricesAction(input: Parameters<typeof addBoxPrices>[2], actor: string | null) {
  const c = await ctx();
  return c ? done(await addBoxPrices(c.db, c.householdId, input, actor)) : NEED_LOGIN;
}
export async function saveBoxSettingsAction(input: Parameters<typeof saveBoxSettings>[2], actor: string | null) {
  const c = await ctx();
  return c ? done(await saveBoxSettings(c.db, c.householdId, input, actor)) : NEED_LOGIN;
}
