"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

/**
 * 抽選の詳細を確認したら、NEW表示を解除する（トレマネが新規に把握した抽選の確認済み印）。
 * 抽選の内容・応募記録には触れない。自世帯の抽選のみ（RLS）。
 */
export async function markLotterySeen(id: string): Promise<{ ok: boolean }> {
  if (!z.uuid().safeParse(id).success) return { ok: false };
  const db = await createClient();
  const { error } = await db.from("lotteries").update({ is_new: false }).eq("id", id).eq("is_new", true);
  return { ok: !error };
}
