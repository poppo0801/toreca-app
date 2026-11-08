"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";

/**
 * 系列の「店舗選択式抽選を基本とする」設定（Stage 7A）。ログイン必須・自世帯のみ（RLS）。
 * ONの系列では、店舗を特定できない抽選を店舗選択式として登録する（個別の抽選・告知に明確な記載があればそちらが優先。注意情報を付ける）。
 */
export async function setChainStoreSelectDefaultAction(chainId: string, on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!z.uuid().safeParse(chainId).success) return { ok: false, error: "リクエストが不正です" };
  try {
    const db = (await createClient()) as unknown as Db;
    const { data } = await db.auth.getUser();
    if (!data.user || !(await currentHouseholdId(db))) return { ok: false, error: "ログインが必要です" };
    const { data: row, error } = await db.from("chains").update({ store_select_default: on }).eq("id", chainId).select("id").maybeSingle();
    if (error || !row) return { ok: false, error: "更新できませんでした" };
    revalidatePath("/settings/masters");
    return { ok: true };
  } catch {
    return { ok: false, error: "更新できませんでした" };
  }
}
