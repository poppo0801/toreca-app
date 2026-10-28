"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { battleInputSchema, type BattleInput } from "@/lib/battle";
import { createClient } from "@/lib/supabase/server";

export type BattleActionResult = { ok: true } | { ok: false; error: string };
const fail = (error: string): BattleActionResult => ({ ok: false, error });
const uuid = z.uuid();

/**
 * 対戦記録の登録(id=null)・編集。ログイン中の本人の権限（RLS: 自世帯のみ）で保存し、操作履歴(audit)に残る。
 * 収支・抽選のデータには触れない。
 */
export async function saveBattle(id: string | null, raw: BattleInput, actor: string | null): Promise<BattleActionResult> {
  const parsed = battleInputSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  if ((id !== null && !uuid.safeParse(id).success) || (actor !== null && !uuid.safeParse(actor).success)) return fail("リクエストが不正です");
  const i = parsed.data;

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const row = {
    played_on: i.playedOn,
    profile_id: i.profileId,
    my_deck: i.myDeck,
    opponent: i.opponent,
    opponent_deck: i.opponentDeck,
    result: i.result,
    turn_order: i.turnOrder,
    format: i.format,
    memo: i.memo,
    updated_by_profile_id: actor,
  };
  if (id) {
    const { data, error } = await supabase.from("battle_records").update(row).eq("id", id).is("archived_at", null).select("id");
    if (error) return fail("保存に失敗しました");
    if (!data || data.length === 0) return fail("対戦記録が見つかりません（他の端末で削除された可能性があります）");
  } else {
    const { data: hh } = await supabase.from("households").select("id").maybeSingle();
    if (!hh) return fail("世帯が見つかりません");
    const { error } = await supabase.from("battle_records").insert({ ...row, household_id: hh.id });
    if (error) return fail("保存に失敗しました");
  }
  revalidatePath("/battles");
  return { ok: true };
}

/** 対戦記録の削除。物理削除はせず、記録を非表示（archived_at）にする（操作履歴は残る） */
export async function deleteBattle(id: string, actor: string | null): Promise<BattleActionResult> {
  if (!uuid.safeParse(id).success || (actor !== null && !uuid.safeParse(actor).success)) return fail("リクエストが不正です");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const { data, error } = await supabase.from("battle_records").update({ archived_at: new Date().toISOString(), updated_by_profile_id: actor }).eq("id", id).is("archived_at", null).select("id");
  if (error) return fail("削除に失敗しました");
  if (!data || data.length === 0) return fail("対戦記録が見つかりません");
  revalidatePath("/battles");
  return { ok: true };
}
