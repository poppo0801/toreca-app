"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { memberNumberSchema, memberNumberUpdateSchema, type MemberNumberInput } from "@/lib/member-number";
import { currentHouseholdId, mapDbError, type Db } from "@/lib/server/lottery-service";
import { createClient } from "@/lib/supabase/server";

/**
 * 会員番号の追加・更新・削除。RLS（自世帯のみ）で守られ、番号はログ・監査ログ・エラーメッセージに出さない。
 * 外部のAI解析・自動収集には渡さない（このファイル以外からは読み書きしない）。
 */
type R = { ok: true } | { ok: false; error: string };

async function authed(): Promise<{ db: Db; householdId: string } | null> {
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

export async function addMemberNumber(raw: MemberNumberInput): Promise<R> {
  const v = memberNumberSchema.safeParse(raw);
  if (!v.success) return { ok: false, error: v.error.issues[0]?.message ?? "入力内容を確認してください" };
  const ctx = await authed();
  if (!ctx) return { ok: false, error: "ログインが必要です" };
  const { error } = await ctx.db.from("member_numbers").insert({ household_id: ctx.householdId, profile_id: v.data.profileId, chain_id: v.data.chainId, member_no: v.data.memberNo, note: v.data.note });
  if (error) return { ok: false, error: error.code === "23505" ? "この系列の会員番号は既に登録されています（編集してください）" : mapDbError(error) };
  revalidatePath("/settings/member-numbers");
  return { ok: true };
}

export async function updateMemberNumber(raw: { id: string; memberNo: string; note?: string }): Promise<R> {
  const v = memberNumberUpdateSchema.safeParse(raw);
  if (!v.success) return { ok: false, error: v.error.issues[0]?.message ?? "入力内容を確認してください" };
  const ctx = await authed();
  if (!ctx) return { ok: false, error: "ログインが必要です" };
  const { data, error } = await ctx.db.from("member_numbers").update({ member_no: v.data.memberNo, note: v.data.note }).eq("id", v.data.id).select("id").maybeSingle();
  if (error) return { ok: false, error: mapDbError(error) };
  if (!data) return { ok: false, error: "対象のデータが見つかりません" };
  revalidatePath("/settings/member-numbers");
  return { ok: true };
}

export async function deleteMemberNumber(id: string): Promise<R> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "リクエストが不正です" };
  const ctx = await authed();
  if (!ctx) return { ok: false, error: "ログインが必要です" };
  const { error } = await ctx.db.from("member_numbers").delete().eq("id", id);
  if (error) return { ok: false, error: mapDbError(error) };
  revalidatePath("/settings/member-numbers");
  return { ok: true };
}
