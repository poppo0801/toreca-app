"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { buildSchema, ENTITIES, ENTITY_KEYS, toDbValues } from "@/lib/masters";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

const entityKeySchema = z.enum(ENTITY_KEYS);
const idSchema = z.uuid();
/** 操作プロフィール（誰として操作したか）。本人認証ではなく、監査ログ用の記録。 */
const actorSchema = z.uuid().nullable();

const fail = (error: string): ActionResult => ({ ok: false, error });

function dbError(e: { code?: string; message: string }): ActionResult {
  switch (e.code) {
    case "23505":
      return fail("同じ名前のデータが既に登録されています");
    case "23503":
      return fail("参照先が存在しない、または他の世帯のデータです");
    case "23514":
      return fail("入力値が制約に違反しています");
    case "42501":
      return fail("この操作は許可されていません");
    default:
      console.error("master action failed", e.code);
      return fail("保存に失敗しました。時間をおいて再度お試しください");
  }
}

async function context() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;
  // RLSにより自世帯の1行だけが見える
  const { data: hh } = await supabase.from("households").select("id").maybeSingle();
  if (!hh) return null;
  return { supabase, householdId: hh.id as string };
}

export async function saveRecord(
  entityKeyRaw: string,
  idRaw: string | null,
  actorRaw: string | null,
  values: Record<string, unknown>,
): Promise<ActionResult> {
  const key = entityKeySchema.safeParse(entityKeyRaw);
  const actor = actorSchema.safeParse(actorRaw);
  const id = idRaw === null ? null : idSchema.safeParse(idRaw);
  if (!key.success || !actor.success || (id && !id.success)) return fail("リクエストが不正です");

  const entity = ENTITIES[key.data];
  const parsed = buildSchema(entity).safeParse(values);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "入力内容を確認してください");

  const ctx = await context();
  if (!ctx) return fail("ログインが必要です");

  const row = { ...toDbValues(entity, parsed.data as Record<string, unknown>), updated_by_profile_id: actor.data };
  const table = ctx.supabase.from(entity.key);
  const { error } = id
    ? await table.update(row).eq("id", id.data!)
    : await table.insert({ ...row, household_id: ctx.householdId });
  if (error) return dbError(error);

  revalidatePath("/settings/masters");
  return { ok: true };
}

/** アーカイブ/有効化の切替。履歴性のあるマスターは物理削除しない。 */
export async function setRetired(
  entityKeyRaw: string,
  idRaw: string,
  retired: boolean,
  actorRaw: string | null,
): Promise<ActionResult> {
  const key = entityKeySchema.safeParse(entityKeyRaw);
  const id = idSchema.safeParse(idRaw);
  const actor = actorSchema.safeParse(actorRaw);
  if (!key.success || !id.success || !actor.success) return fail("リクエストが不正です");
  const entity = ENTITIES[key.data];

  const ctx = await context();
  if (!ctx) return fail("ログインが必要です");

  if (entity.key === "profiles" && retired) {
    const { count } = await ctx.supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("active", true);
    if ((count ?? 0) <= 1) return fail("有効なプロフィールを0件にはできません");
  }

  const table = ctx.supabase.from(entity.key);
  const { error } =
    entity.retire === "delete"
      ? await table.delete().eq("id", id.data)
      : entity.retire === "archived_at"
        ? await table
            .update({ archived_at: retired ? new Date().toISOString() : null, updated_by_profile_id: actor.data })
            .eq("id", id.data)
        : await table.update({ active: !retired, updated_by_profile_id: actor.data }).eq("id", id.data);
  if (error) return dbError(error);

  revalidatePath("/settings/masters");
  return { ok: true };
}

const rulesSchema = z.object({
  profileId: z.uuid(),
  allow: z.array(z.uuid()).max(200),
  block: z.array(z.uuid()).max(200),
});

/**
 * プロフィールの対象系列。allow が1件でもあれば許可リスト方式（Cなど）、block は常に除外。
 * 同じ系列を両方に入れることはできない。
 */
export async function setProfileRules(
  input: z.input<typeof rulesSchema>,
  actorRaw: string | null,
): Promise<ActionResult> {
  const parsed = rulesSchema.safeParse(input);
  const actor = actorSchema.safeParse(actorRaw);
  if (!parsed.success || !actor.success) return fail("リクエストが不正です");
  const { profileId, allow, block } = parsed.data;
  if (allow.some((c) => block.includes(c))) return fail("同じ系列を許可と除外の両方には指定できません");

  const ctx = await context();
  if (!ctx) return fail("ログインが必要です");

  const desired = [
    ...allow.map((chain_id) => ({ chain_id, mode: "allow" as const })),
    ...block.map((chain_id) => ({ chain_id, mode: "block" as const })),
  ];
  if (desired.length > 0) {
    const { error } = await ctx.supabase.from("profile_target_rules").upsert(
      desired.map((d) => ({
        household_id: ctx.householdId,
        profile_id: profileId,
        chain_id: d.chain_id,
        mode: d.mode,
        updated_by_profile_id: actor.data,
      })),
      { onConflict: "profile_id,chain_id" },
    );
    if (error) return dbError(error);
  }
  const keep = desired.map((d) => d.chain_id);
  const del = ctx.supabase.from("profile_target_rules").delete().eq("profile_id", profileId);
  const { error: delError } = keep.length > 0 ? await del.not("chain_id", "in", `(${keep.join(",")})`) : await del;
  if (delError) return dbError(delError);

  revalidatePath("/settings/masters");
  return { ok: true };
}
