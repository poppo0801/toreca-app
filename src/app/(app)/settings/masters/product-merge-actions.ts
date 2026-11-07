"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { deleteProduct, mergeProducts, previewMerge, productReferences, type MergePreview, type MergeResult } from "@/lib/server/product-merge-service";
import type { RefCounts } from "@/lib/product-merge";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";

/** 商品マスターの削除・統合（Stage 6P）。ログイン必須・自世帯のみ（RLS と DB 関数の世帯確認）。 */
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

export async function productReferencesAction(productId: string): Promise<R<{ counts: RefCounts }>> {
  const db = await ctx();
  if (!db) return NEED;
  const r = await productReferences(db, productId);
  return r.ok ? { ok: true, counts: r.value } : { ok: false, error: r.error };
}

export async function deleteProductAction(productId: string): Promise<R> {
  const db = await ctx();
  if (!db) return NEED;
  const r = await deleteProduct(db, productId);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/settings/masters");
  return { ok: true };
}

export async function previewMergeAction(fromId: string, intoId: string, actor: string | null): Promise<R<{ preview: MergePreview & { already?: boolean } }>> {
  const db = await ctx();
  if (!db) return NEED;
  const r = await previewMerge(db, fromId, intoId, actor);
  return r.ok ? { ok: true, preview: r.value } : { ok: false, error: r.error };
}

export async function mergeProductsAction(fromId: string, intoId: string, actor: string | null): Promise<R<{ result: MergeResult }>> {
  const db = await ctx();
  if (!db) return NEED;
  const r = await mergeProducts(db, fromId, intoId, actor);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/settings/masters");
  revalidatePath("/collection");
  revalidatePath("/lotteries");
  return { ok: true, result: r.value };
}
