"use server";

import { z } from "zod";
import { parsePriceInput, priceRow, toMarketCard, toMarketPrice, toMarketPurchase, type MarketCard, type MarketPrice, type MarketPurchase } from "@/lib/zukan/rows";
import { matchCard, type PriceInput } from "@/lib/zukan/zukan";
import { createClient } from "@/lib/supabase/server";

/**
 * 相場調査メモの読み書き（Stage Collection-1）。ログイン必須・自世帯のみ（RLS）。**プロフィール単位**（profile_id で絞る）。
 * 151図鑑の価格調査とは別の表。既存の購入記録・コレクション・支出には書き込まない（二重計上の防止）。
 * カードは、収録セット・カード番号・レアリティで同一性を判定し（カード名だけでは同一としない）、曖昧なときは利用者に確認する。
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
const mapError = (e: { code?: string }) => (e.code === "23505" ? "すでに登録済みです" : e.code === "23503" ? "履歴があるため削除できません" : e.code === "42501" ? "権限がありません" : e.code === "23514" ? "入力内容を確認してください" : "保存できませんでした。もう一度お試しください");
async function householdOf(db: Db): Promise<string | null> {
  const { data } = await any(db).from("households").select("id").maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

export interface MarketData {
  cards: MarketCard[];
  prices: MarketPrice[];
  purchases: MarketPurchase[];
}

export async function loadMarketAction(profileId: string): Promise<R<{ data: MarketData }>> {
  if (!uuid.safeParse(profileId).success) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const [c, p, b] = await Promise.all([
    any(db).from("market_cards").select("*").eq("profile_id", profileId).order("created_at", { ascending: false }).limit(5000),
    any(db).from("market_prices").select("*").eq("profile_id", profileId).order("surveyed_on", { ascending: false }).limit(20000),
    any(db).from("market_purchases").select("*").eq("profile_id", profileId).limit(20000),
  ]);
  if (c.error || p.error || b.error) return fail("読み込めませんでした");
  return { ok: true, data: { cards: (c.data ?? []).map(toMarketCard), prices: (p.data ?? []).map(toMarketPrice), purchases: (b.data ?? []).map(toMarketPurchase) } };
}

const cardInput = z.object({
  name: z.string().trim().min(1, "カード名を入力してください").max(80, "カード名は80文字以内で入力してください"),
  setName: z.string().trim().max(120, "収録セットは120文字以内で入力してください").default(""),
  cardNumber: z.string().trim().max(20, "カード番号は20文字以内で入力してください").default(""),
  rarity: z.string().trim().max(10, "レアリティは10文字以内で入力してください").default(""),
  note: z.string().trim().max(500, "補足は500文字以内で入力してください").default(""),
});
export type MarketCardInput = z.input<typeof cardInput>;

/**
 * カードを登録する。同一のカード（セット・番号・レアリティが一致）があれば新規作成せず、そのカードを返す（reused）。
 * 曖昧（名前が同じ・識別情報が足りない・レアリティだけ違う）なときは、allowAmbiguous=false なら新規作成せず候補を返して確認を求める。
 */
export async function createMarketCardAction(profileId: string, input: MarketCardInput, allowAmbiguous: boolean): Promise<R<{ id: string; reused: boolean }> | { ok: false; error: string; ambiguous: MarketCard[] }> {
  if (!uuid.safeParse(profileId).success) return fail("リクエストが不正です");
  const p = cardInput.safeParse(input);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const hid = await householdOf(db);
  if (!hid) return fail("世帯が見つかりません");
  const { data: rows, error: le } = await any(db).from("market_cards").select("*").eq("profile_id", profileId).limit(5000);
  if (le) return fail("読み込めませんでした");
  const existing = (rows ?? []).map(toMarketCard);
  const m = matchCard<MarketCard>(existing, { name: p.data.name, setName: p.data.setName, cardNumber: p.data.cardNumber, rarity: p.data.rarity });
  if (m.kind === "same") return { ok: true, id: m.card.id, reused: true };
  if (m.kind === "ambiguous" && !allowAmbiguous) return { ok: false, error: "同じカードか判断できません。既存のカードを選ぶか、別のカードとして登録してください", ambiguous: m.candidates };
  const { data, error } = await any(db).from("market_cards").insert({ household_id: hid, profile_id: profileId, name: p.data.name, set_name: p.data.setName, card_number: p.data.cardNumber, rarity: p.data.rarity, note: p.data.note }).select("id").single();
  if (error) return fail(mapError(error));
  return { ok: true, id: data.id as string, reused: false };
}

export async function updateMarketCardAction(profileId: string, id: string, input: MarketCardInput): Promise<R> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(id).success) return fail("リクエストが不正です");
  const p = cardInput.safeParse(input);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data, error } = await any(db).from("market_cards").update({ name: p.data.name, set_name: p.data.setName, card_number: p.data.cardNumber, rarity: p.data.rarity, note: p.data.note, updated_at: new Date().toISOString() }).eq("id", id).eq("profile_id", profileId).select("id");
  if (error) return fail(error.code === "23505" ? "同じセット・番号・レアリティのカードがすでにあります" : mapError(error));
  return data?.length === 1 ? { ok: true } : fail("対象が見つかりません");
}

/** カードの削除。価格の履歴・購入記録があるカードは削除できない（履歴を失わない） */
export async function deleteMarketCardAction(profileId: string, id: string): Promise<R> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(id).success) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data, error } = await any(db).from("market_cards").delete().eq("id", id).eq("profile_id", profileId).select("id");
  if (error) return fail(error.code === "23503" ? "価格の履歴があるカードは削除できません" : mapError(error));
  return data?.length === 1 ? { ok: true } : fail("対象が見つかりません");
}

export async function addMarketPriceAction(profileId: string, cardId: string, input: PriceInput): Promise<R<{ id: string }>> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(cardId).success) return fail("リクエストが不正です");
  const price = parsePriceInput(input);
  if (!price.success) return fail(price.error.issues[0]?.message ?? "入力内容を確認してください");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const hid = await householdOf(db);
  if (!hid) return fail("世帯が見つかりません");
  // 操作しているプロフィールのカードにだけ追加できる
  const { data: card } = await any(db).from("market_cards").select("id").eq("id", cardId).eq("profile_id", profileId).maybeSingle();
  if (!card) return fail("対象のカードが見つかりません");
  const { data, error } = await any(db).from("market_prices").insert({ household_id: hid, profile_id: profileId, card_id: cardId, ...priceRow(price.data, "memo") }).select("id").single();
  if (error) return fail(mapError(error));
  return { ok: true, id: data.id as string };
}

export async function updateMarketPriceAction(profileId: string, id: string, input: PriceInput): Promise<R> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(id).success) return fail("リクエストが不正です");
  const price = parsePriceInput(input);
  if (!price.success) return fail(price.error.issues[0]?.message ?? "入力内容を確認してください");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data, error } = await any(db).from("market_prices").update({ ...priceRow(price.data, "memo"), updated_at: new Date().toISOString() }).eq("id", id).eq("profile_id", profileId).select("id");
  if (error) return fail(mapError(error));
  return data?.length === 1 ? { ok: true } : fail("対象が見つかりません");
}

/** 価格記録の削除。購入済みの記録は削除できない（購入の根拠を失わない） */
export async function deleteMarketPriceAction(profileId: string, id: string): Promise<R> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(id).success) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data, error } = await any(db).from("market_prices").delete().eq("id", id).eq("profile_id", profileId).select("id");
  if (error) return fail(error.code === "23503" ? "購入済みの価格記録は削除できません" : mapError(error));
  return data?.length === 1 ? { ok: true } : fail("対象が見つかりません");
}

/** 「この価格で購入」: 購入日・店舗・価格・状態を引き継いで購入済みの記録を作る（1つの価格記録からは1回だけ）。購入後も価格の履歴・カードは残る */
export async function buyMarketFromPriceAction(profileId: string, priceId: string, purchasedOn: string): Promise<R<{ purchaseId: string }>> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(priceId).success || !/^\d{4}-\d{2}-\d{2}$/.test(purchasedOn)) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data: rec } = await any(db).from("market_prices").select("id").eq("id", priceId).eq("profile_id", profileId).maybeSingle();
  if (!rec) return fail("対象が見つかりません");
  const { data, error } = await any(db).rpc("market_buy_from_price_tx", { p_price: priceId, p_purchased_on: purchasedOn });
  if (error) return fail(error.code === "23505" ? "この価格の記録からは、すでに購入済みです" : mapError(error));
  return { ok: true, purchaseId: data as string };
}

/** バックアップ用: このプロフィールの相場調査メモ（カード・価格・購入）をJSONで返す */
export async function exportMarketAction(profileId: string): Promise<R<{ json: string }>> {
  const r = await loadMarketAction(profileId);
  if (!r.ok) return r;
  return { ok: true, json: JSON.stringify({ format: "toremane-market-memo", version: 1, exportedAt: new Date().toISOString(), profileId, ...r.data }, null, 1) };
}
