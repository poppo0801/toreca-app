/**
 * DBの行 ⇄ アプリの型（Stage Collection-1・純関数）。151図鑑と相場調査メモの共通の変換。
 */
import type { AcquireMethod, ZukanCard, ZukanCardInput } from "@/lib/zukan/zukan";
import { zukanCardInputSchema, type PriceInput } from "@/lib/zukan/zukan";
import { priceInputSchema } from "@/lib/zukan/zukan";

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const n = (v: unknown) => (typeof v === "number" ? v : v == null ? null : Number(v));

export interface ZukanPriceRecord {
  id: string;
  profileId: string;
  dexNo: number;
  cardName: string;
  setName: string;
  cardNumber: string;
  rarity: string;
  storeName: string;
  chainName: string;
  surveyedOn: string;
  condition: string;
  priceYen: number;
  note: string;
  createdAt: string;
}

export const toZukanCard = (r: Row): ZukanCard => ({
  id: s(r.id),
  profileId: s(r.profile_id),
  dexNo: Number(r.dex_no),
  cardName: s(r.card_name),
  setName: s(r.set_name),
  cardNumber: s(r.card_number),
  rarity: s(r.rarity),
  quantity: Number(r.quantity),
  acquiredOn: r.acquired_on ? s(r.acquired_on) : null,
  acquireMethod: (r.acquire_method === "single_purchase" ? "single_purchase" : "pack_opening") as AcquireMethod,
  // 未入力は null のまま（0円にしない）
  purchaseAmountYen: r.purchase_amount_yen == null ? null : Number(r.purchase_amount_yen),
  storeName: s(r.store_name),
  condition: s(r.condition),
  memo: s(r.memo),
  priceRecordId: r.price_record_id ? s(r.price_record_id) : null,
});

export const toZukanPrice = (r: Row): ZukanPriceRecord => ({
  id: s(r.id),
  profileId: s(r.profile_id),
  dexNo: Number(r.dex_no),
  cardName: s(r.card_name),
  setName: s(r.set_name),
  cardNumber: s(r.card_number),
  rarity: s(r.rarity),
  storeName: s(r.store_name),
  chainName: s(r.chain_name),
  surveyedOn: s(r.surveyed_on),
  condition: s(r.condition),
  priceYen: Number(r.price_yen),
  note: s(r.note),
  createdAt: s(r.created_at),
});

/** 検証済みの収集カード入力 → DBの列 */
export function zukanCardRow(v: ReturnType<typeof zukanCardInputSchema.parse>): Row {
  return {
    dex_no: v.dexNo,
    card_name: v.cardName,
    set_name: v.setName,
    card_number: v.cardNumber,
    rarity: v.rarity,
    quantity: v.quantity,
    acquired_on: v.acquiredOn === "" ? null : v.acquiredOn,
    acquire_method: v.acquireMethod,
    purchase_amount_yen: v.purchaseAmountYen,
    store_name: v.storeName,
    condition: v.condition,
    memo: v.memo,
  };
}

export const parseZukanCardInput = (input: ZukanCardInput) => zukanCardInputSchema.safeParse(input);

/** 検証済みの価格入力 → DBの列（共通。151図鑑専用は dex_no と カード情報を、相場調査メモは card_id を別に足す） */
export function priceRow(v: ReturnType<typeof priceInputSchema.parse>, memoKey: "note" | "memo"): Row {
  return { store_name: v.storeName, chain_name: v.chainName, surveyed_on: v.surveyedOn, condition: v.condition, price_yen: v.priceYen, [memoKey]: v.note };
}
export const parsePriceInput = (input: PriceInput) => priceInputSchema.safeParse(input);

export interface MarketCard {
  id: string;
  profileId: string;
  name: string;
  setName: string;
  cardNumber: string;
  rarity: string;
  note: string;
  createdAt: string;
}
export interface MarketPrice {
  id: string;
  profileId: string;
  cardId: string;
  storeName: string;
  chainName: string;
  surveyedOn: string;
  condition: string;
  priceYen: number;
  note: string;
  createdAt: string;
}
export interface MarketPurchase {
  id: string;
  cardId: string;
  priceId: string;
  purchasedOn: string;
  storeName: string;
  priceYen: number;
  condition: string;
}
export const toMarketCard = (r: Row): MarketCard => ({ id: s(r.id), profileId: s(r.profile_id), name: s(r.name), setName: s(r.set_name), cardNumber: s(r.card_number), rarity: s(r.rarity), note: s(r.note), createdAt: s(r.created_at) });
export const toMarketPrice = (r: Row): MarketPrice => ({ id: s(r.id), profileId: s(r.profile_id), cardId: s(r.card_id), storeName: s(r.store_name), chainName: s(r.chain_name), surveyedOn: s(r.surveyed_on), condition: s(r.condition), priceYen: Number(n(r.price_yen)), note: s(r.memo), createdAt: s(r.created_at) });
export const toMarketPurchase = (r: Row): MarketPurchase => ({ id: s(r.id), cardId: s(r.card_id), priceId: s(r.price_id), purchasedOn: s(r.purchased_on), storeName: s(r.store_name), priceYen: Number(n(r.price_yen)), condition: s(r.condition) });
