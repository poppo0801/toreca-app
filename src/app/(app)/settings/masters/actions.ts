"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { buildSchema, ENTITIES, ENTITY_KEYS, toDbValues } from "@/lib/masters";
import { createClient } from "@/lib/supabase/server";
import { processGeocodeBatch, requeueFailedGeocoding } from "@/lib/server/geocode-service";
import type { Db } from "@/lib/server/lottery-service";

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

  const dbValues = toDbValues(entity, parsed.data as Record<string, unknown>);
  // 店舗の位置は緯度と経度が両方あるときだけ有効（片方だけでは距離を計算できない）
  if (entity.key === "stores" && (dbValues.latitude == null) !== (dbValues.longitude == null)) return fail("緯度と経度は両方入力してください（住所から位置を取得することもできます）");
  // 資格はアカウントと同じ系列の条件にだけ紐づけられる（chain_id はアカウントから補完。複合FKで不一致はDBが拒否）
  if (entity.key === "account_eligibilities") {
    const { data: acc } = await ctx.supabase.from("service_accounts").select("chain_id").eq("id", String(dbValues.service_account_id)).maybeSingle();
    if (!acc) return fail("応募アカウントが見つかりません");
    dbValues.chain_id = acc.chain_id;
  }
  // 仮登録（抽選登録時に自動作成）されたマスターは、マスター管理で保存した時点で確定扱いにする
  const confirmsProvisional = id && (entity.key === "chains" || entity.key === "stores" || entity.key === "products");
  const row = { ...dbValues, ...(confirmsProvisional ? { is_provisional: false } : {}), updated_by_profile_id: actor.data };
  const table = ctx.supabase.from(entity.key);
  const { error } = id
    ? await table.update(row).eq("id", id.data!)
    : await table.insert({ ...row, household_id: ctx.householdId });
  if (error) return dbError(error);

  // 店舗の住所を登録・変更したら、保存とは別に（応答のあとで）位置情報を取得する。失敗しても保存には影響せず、定期処理が再試行する
  if (entity.key === "stores") after(() => processGeocodeBatch(ctx.supabase as unknown as Db, { limit: 3 }).then(() => undefined, () => undefined));
  revalidatePath("/settings/masters");
  return { ok: true };
}

/** 取得失敗の店舗だけを取得待ちに戻して、すぐ再取得を始める（住所不完全の店舗は対象外。住所を補完すると自動で取得待ちになる） */
export async function retryFailedGeocoding(): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "ログインが必要です" };
  const count = await requeueFailedGeocoding(ctx.supabase as unknown as Db);
  if (count > 0) after(() => processGeocodeBatch(ctx.supabase as unknown as Db, { limit: 8 }).then(() => undefined, () => undefined));
  revalidatePath("/settings/masters");
  return { ok: true, count };
}

/**
 * 系列・店舗・商品の一括「非表示／再表示」(archived_at の設定/解除)。削除ではなく、既存の抽選・応募履歴との紐付けはそのまま残る。
 * 非表示にした項目は新規登録の選択候補から外れる。最大200件。
 */
export async function setRetiredBulk(entityKeyRaw: string, idsRaw: string[], retired: boolean, actorRaw: string | null): Promise<ActionResult> {
  const key = entityKeySchema.safeParse(entityKeyRaw);
  const ids = z.array(idSchema).min(1).max(200).safeParse(idsRaw);
  const actor = actorSchema.safeParse(actorRaw);
  if (!key.success || !ids.success || !actor.success) return fail("リクエストが不正です");
  const entity = ENTITIES[key.data];
  if (entity.retire !== "archived_at" || !["chains", "stores", "products"].includes(entity.key)) return fail("この種類は一括で非表示にできません");
  const ctx = await context();
  if (!ctx) return fail("ログインが必要です");
  const { error } = await ctx.supabase
    .from(entity.key as "chains" | "stores" | "products")
    .update({ archived_at: retired ? new Date().toISOString() : null, updated_by_profile_id: actor.data })
    .in("id", ids.data);
  if (error) return dbError(error);
  revalidatePath("/settings/masters");
  return { ok: true };
}

/** 非表示/有効化の切替。履歴性のあるマスターは物理削除しない。 */
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
