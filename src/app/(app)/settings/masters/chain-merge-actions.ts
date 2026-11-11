"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { deleteChain, mergeChains, previewChainMerge, chainReferences, type ChainMergePreview, type ChainMergeResult } from "@/lib/server/chain-merge-service";
import type { ChainRefCounts as RefCounts } from "@/lib/chain-merge";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";

/** 系列マスターの削除・統合（Stage 6Q）。ログイン必須・自世帯のみ（RLS と DB 関数の世帯確認）。 */
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

export async function chainReferencesAction(chainId: string): Promise<R<{ counts: RefCounts }>> {
  const db = await ctx();
  if (!db) return NEED;
  const r = await chainReferences(db, chainId);
  return r.ok ? { ok: true, counts: r.value } : { ok: false, error: r.error };
}

export async function deleteChainAction(chainId: string): Promise<R> {
  const db = await ctx();
  if (!db) return NEED;
  const r = await deleteChain(db, chainId);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/settings/masters");
  return { ok: true };
}

export async function previewChainMergeAction(fromId: string, intoId: string, actor: string | null): Promise<R<{ preview: ChainMergePreview & { already?: boolean } }>> {
  const db = await ctx();
  if (!db) return NEED;
  const r = await previewChainMerge(db, fromId, intoId, actor);
  return r.ok ? { ok: true, preview: r.value } : { ok: false, error: r.error };
}

export async function mergeChainsAction(fromId: string, intoId: string, actor: string | null): Promise<R<{ result: ChainMergeResult }>> {
  const db = await ctx();
  if (!db) return NEED;
  const r = await mergeChains(db, fromId, intoId, actor);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, result: r.value };
}
