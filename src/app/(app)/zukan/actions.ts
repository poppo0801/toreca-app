"use server";

import { z } from "zod";
import { parsePriceInput, parseZukanCardInput, priceRow, toZukanCard, toZukanPrice, zukanCardRow, type ZukanPriceRecord } from "@/lib/zukan/rows";
import type { PriceInput, ZukanCard, ZukanCardInput } from "@/lib/zukan/zukan";
import { pokemonOf } from "@/lib/zukan/pokemon151";
import { createClient } from "@/lib/supabase/server";

/**
 * 151図鑑の読み書き（Stage Collection-1）。ログイン必須・自世帯のみ（RLS）。**プロフィール単位**: 読み書きはすべて profile_id で絞る。
 * 入力はサーバーで必ず再検証する。既存の購入記録（purchases）・コレクション（card_holdings）・支出には一切書き込まない（二重計上の防止）。
 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const uuid = z.uuid();

async function ctx() {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return data.user ? supabase : null;
  } catch {
    return null;
  }
}
type Db = NonNullable<Awaited<ReturnType<typeof ctx>>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
const any = (db: Db) => db as any;
const mapError = (e: { code?: string; message?: string }) => (e.code === "23505" ? "すでに登録済みです" : e.code === "23503" ? "対象が見つかりません" : e.code === "42501" ? "権限がありません" : e.code === "23514" ? "入力内容を確認してください" : "保存できませんでした。もう一度お試しください");

export interface ZukanData {
  cards: ZukanCard[];
  prices: ZukanPriceRecord[];
}

export async function loadZukanAction(profileId: string): Promise<R<{ data: ZukanData }>> {
  if (!uuid.safeParse(profileId).success) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const [c, p] = await Promise.all([
    any(db).from("zukan_cards").select("*").eq("profile_id", profileId).order("dex_no").order("created_at").limit(5000),
    any(db).from("zukan_price_records").select("*").eq("profile_id", profileId).order("surveyed_on", { ascending: false }).limit(5000),
  ]);
  if (c.error || p.error) return fail("読み込めませんでした");
  return { ok: true, data: { cards: (c.data ?? []).map(toZukanCard), prices: (p.data ?? []).map(toZukanPrice) } };
}

/** 収集カードを登録（id なし）または更新（id あり） */
export async function saveZukanCardAction(profileId: string, id: string | null, input: ZukanCardInput): Promise<R<{ id: string }>> {
  if (!uuid.safeParse(profileId).success || (id !== null && !uuid.safeParse(id).success)) return fail("リクエストが不正です");
  const parsed = parseZukanCardInput(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  if (!pokemonOf(parsed.data.dexNo)) return fail("図鑑番号が正しくありません");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  if (id === null) {
    const hid = await householdOf(db);
    if (!hid) return fail("世帯が見つかりません");
    const { data, error } = await any(db).from("zukan_cards").insert({ household_id: hid, profile_id: profileId, ...zukanCardRow(parsed.data) }).select("id").single();
    if (error) return fail(mapError(error));
    return { ok: true, id: data.id as string };
  }
  const { data, error } = await any(db).from("zukan_cards").update({ ...zukanCardRow(parsed.data), updated_at: new Date().toISOString() }).eq("id", id).eq("profile_id", profileId).select("id");
  if (error) return fail(mapError(error));
  if (!data || data.length !== 1) return fail("対象が見つかりません");
  return { ok: true, id };
}

/** 収集カードの削除（呼び出し側で確認操作を行う）。この表だけを削除し、購入記録・価格調査の履歴には触れない */
export async function deleteZukanCardAction(profileId: string, id: string): Promise<R> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(id).success) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data, error } = await any(db).from("zukan_cards").delete().eq("id", id).eq("profile_id", profileId).select("id");
  if (error) return fail(mapError(error));
  return data?.length === 1 ? { ok: true } : fail("対象が見つかりません");
}

async function householdOf(db: Db): Promise<string | null> {
  const { data } = await any(db).from("households").select("id").maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** 価格調査の記録を追加（ポケモン・カード情報つき） */
export async function addZukanPriceAction(profileId: string, dexNo: number, card: { cardName: string; setName: string; cardNumber: string; rarity: string }, input: PriceInput): Promise<R<{ id: string }>> {
  if (!uuid.safeParse(profileId).success || !pokemonOf(dexNo)) return fail("リクエストが不正です");
  const price = parsePriceInput(input);
  if (!price.success) return fail(price.error.issues[0]?.message ?? "入力内容を確認してください");
  const name = card.cardName.trim();
  if (!name || name.length > 80) return fail("カード名を入力してください");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const hid = await householdOf(db);
  if (!hid) return fail("世帯が見つかりません");
  const { data, error } = await any(db)
    .from("zukan_price_records")
    .insert({ household_id: hid, profile_id: profileId, dex_no: dexNo, card_name: name, set_name: card.setName.trim().slice(0, 120), card_number: card.cardNumber.trim().slice(0, 20), rarity: card.rarity.trim().slice(0, 10), ...priceRow(price.data, "note") })
    .select("id")
    .single();
  if (error) return fail(mapError(error));
  return { ok: true, id: data.id as string };
}

export async function updateZukanPriceAction(profileId: string, id: string, input: PriceInput): Promise<R> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(id).success) return fail("リクエストが不正です");
  const price = parsePriceInput(input);
  if (!price.success) return fail(price.error.issues[0]?.message ?? "入力内容を確認してください");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data, error } = await any(db).from("zukan_price_records").update({ ...priceRow(price.data, "note"), updated_at: new Date().toISOString() }).eq("id", id).eq("profile_id", profileId).select("id");
  if (error) return fail(mapError(error));
  return data?.length === 1 ? { ok: true } : fail("対象が見つかりません");
}

/** 価格調査の記録を削除する（購入済みの収集カードは残り、元の記録への参照だけが外れる） */
export async function deleteZukanPriceAction(profileId: string, id: string): Promise<R> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(id).success) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data, error } = await any(db).from("zukan_price_records").delete().eq("id", id).eq("profile_id", profileId).select("id");
  if (error) return fail(mapError(error));
  return data?.length === 1 ? { ok: true } : fail("対象が見つかりません");
}

/** 「この価格で購入」: 価格調査の記録のカード・店舗・価格・状態を引き継いで、収集カード（単品購入）を登録する。1つの記録からは1回だけ。購入後も価格の履歴は残る */
export async function buyZukanFromPriceAction(profileId: string, priceId: string, acquiredOn: string): Promise<R<{ cardId: string }>> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(priceId).success || !/^\d{4}-\d{2}-\d{2}$/.test(acquiredOn)) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  // 操作しているプロフィールの記録だけを購入できる
  const { data: rec } = await any(db).from("zukan_price_records").select("id").eq("id", priceId).eq("profile_id", profileId).maybeSingle();
  if (!rec) return fail("対象が見つかりません");
  const { data, error } = await any(db).rpc("zukan_buy_from_price_tx", { p_price: priceId, p_acquired_on: acquiredOn });
  if (error) return fail(error.code === "23505" ? "この価格の記録からは、すでに購入済みです" : mapError(error));
  return { ok: true, cardId: data as string };
}

/** バックアップ用: このプロフィールの図鑑データ（収集カード・価格調査）をJSONで返す */
export async function exportZukanAction(profileId: string): Promise<R<{ json: string }>> {
  const r = await loadZukanAction(profileId);
  if (!r.ok) return r;
  return { ok: true, json: JSON.stringify({ format: "toremane-zukan", version: 1, exportedAt: new Date().toISOString(), profileId, cards: r.data.cards, prices: r.data.prices }, null, 1) };
}
