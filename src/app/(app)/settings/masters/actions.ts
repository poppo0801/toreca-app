"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { buildSchema, ENTITIES, ENTITY_KEYS, normalizeAlias, toDbValues } from "@/lib/masters";
import { checkChainAliases } from "@/lib/chain-alias";
import { sameChainName } from "@/lib/chain-normalize";
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
  /** 系列の別名（chains のときだけ使う。指定すると、保存後の別名がこの一覧になる） */
  aliasesRaw?: string[],
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
  // 系列の別名: 保存の前に、他の系列の名称・別名との衝突を確認する（衝突があれば系列も保存しない）
  let aliasPlan: string[] | null = null;
  if (entity.key === "chains" && aliasesRaw !== undefined) {
    const list = z.array(z.string().max(200)).max(50).safeParse(aliasesRaw);
    if (!list.success) return fail("別名の形式が正しくありません");
    const [{ data: cs }, { data: as }] = await Promise.all([ctx.supabase.from("chains").select("id,name"), ctx.supabase.from("chain_aliases").select("chain_id,alias")]);
    const checked = checkChainAliases(id ? id.data! : null, String(dbValues.name ?? ""), list.data, cs ?? [], (as ?? []).map((a) => ({ chainId: a.chain_id, alias: a.alias })));
    if (checked.problems.length > 0) return fail(checked.problems[0].message);
    aliasPlan = checked.values;
  }
  // Stage 9C: 新しい系列は、表記の違い（記号・括弧書きの読み・通販の語）だけで既存の系列と同じなら作らない（別名の追加を案内する）。共通ブランドの系列（直営/その他）は対象外
  if (entity.key === "chains" && !id) {
    const [{ data: cs }, { data: as }] = await Promise.all([ctx.supabase.from("chains").select("id,name,brand_group,archived_at"), ctx.supabase.from("chain_aliases").select("chain_id,alias")]);
    const name = String(dbValues.name ?? "");
    const hit = (cs ?? []).find((c) => !c.brand_group && !c.archived_at && (sameChainName(c.name, name) || (as ?? []).some((a) => a.chain_id === c.id && sameChainName(a.alias, name))));
    if (hit) return fail(`「${name}」は既存の系列「${hit.name}」と表記が違うだけの同じ系列です。新しく作らず、「${hit.name}」の別名に追加してください`);
  }
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

  // 系列の別名を保存後の一覧に合わせる（追加・削除）。系列の保存とは別の操作のため、失敗したときは別名だけ保存できなかったと伝える
  if (entity.key === "chains" && aliasPlan) {
    let chainId = id ? id.data! : null;
    if (!chainId) {
      const { data: created } = await ctx.supabase.from("chains").select("id").eq("name", String(dbValues.name)).eq("household_id", ctx.householdId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      chainId = created?.id ?? null;
    }
    if (chainId) {
      const { data: cur } = await ctx.supabase.from("chain_aliases").select("id,alias,normalized_alias").eq("chain_id", chainId);
      const want = new Map(aliasPlan.map((a) => [normalizeAlias(a), a]));
      const remove = (cur ?? []).filter((r) => !want.has(r.normalized_alias)).map((r) => r.id);
      const have = new Set((cur ?? []).map((r) => r.normalized_alias));
      const add = [...want.entries()].filter(([k]) => !have.has(k)).map(([k, a]) => ({ household_id: ctx.householdId, chain_id: chainId as string, alias: a, normalized_alias: k, updated_by_profile_id: actor.data }));
      if (remove.length > 0) {
        const { error: dErr } = await ctx.supabase.from("chain_aliases").delete().in("id", remove);
        if (dErr) return fail("系列は保存しましたが、別名を保存できませんでした。もう一度お試しください");
      }
      if (add.length > 0) {
        const { error: iErr } = await ctx.supabase.from("chain_aliases").insert(add);
        if (iErr) return fail(iErr.code === "23505" ? "別名が他の系列の別名と重複しています" : "系列は保存しましたが、別名を保存できませんでした。もう一度お試しください");
      }
    }
  }

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
