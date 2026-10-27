"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export type SetActionResult = { ok: true } | { ok: false; error: string };
const fail = (error: string): SetActionResult => ({ ok: false, error });

const inputSchema = z.object({
  setProductId: z.uuid(),
  actor: z.uuid().nullable(),
  items: z
    .array(z.object({ componentProductId: z.uuid(), quantity: z.number().int().min(1, "数量は1以上").max(999, "数量は999以下") }))
    .max(50, "構成商品は50件までです"),
});
export type SetCompositionInput = z.input<typeof inputSchema>;

/**
 * セット商品の構成（含まれる商品と数量）を保存する。構造の記録だけで、購入の数量・金額には加算しない。
 * 構成が不明なものは空のまま残す（推測で登録しない）。変更は差分だけを反映し、操作履歴(audit)に残る。
 */
export async function saveSetComposition(raw: SetCompositionInput): Promise<SetActionResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  const { setProductId, actor, items } = parsed.data;
  const ids = items.map((i) => i.componentProductId);
  if (new Set(ids).size !== ids.length) return fail("同じ商品が重複しています");
  if (ids.includes(setProductId)) return fail("セット商品自身は構成に含められません");

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const { data: hh } = await supabase.from("households").select("id").maybeSingle();
  if (!hh) return fail("世帯が見つかりません");

  const { data: current, error: e1 } = await supabase.from("product_set_items").select("id,component_product_id,quantity").eq("set_product_id", setProductId);
  if (e1) return fail("構成の取得に失敗しました");
  const have = new Map((current ?? []).map((c) => [c.component_product_id as string, c]));

  const removed = (current ?? []).filter((c) => !ids.includes(c.component_product_id as string));
  if (removed.length > 0) {
    const { error } = await supabase.from("product_set_items").delete().in("id", removed.map((r) => r.id as string));
    if (error) return fail("構成の更新に失敗しました");
  }
  for (const it of items) {
    const cur = have.get(it.componentProductId);
    if (!cur) {
      const { error } = await supabase
        .from("product_set_items")
        .insert({ household_id: hh.id, set_product_id: setProductId, component_product_id: it.componentProductId, quantity: it.quantity, updated_by_profile_id: actor });
      if (error) return fail(error.code === "23505" ? "同じ商品が重複しています" : "構成の追加に失敗しました（他の世帯の商品は指定できません）");
    } else if (cur.quantity !== it.quantity) {
      const { error } = await supabase.from("product_set_items").update({ quantity: it.quantity, updated_by_profile_id: actor }).eq("id", cur.id as string);
      if (error) return fail("構成の更新に失敗しました");
    }
  }
  revalidatePath("/settings/masters");
  return { ok: true };
}
