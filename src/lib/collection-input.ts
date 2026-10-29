import { z } from "zod";

/** コレクションの入力検証（画面・サーバー共通。サーバーでも必ず再検証する） */
const text = (label: string, max: number) => z.string().trim().max(max, `${label}は${max}文字以内で入力してください`).default("");
const url = z.union([z.literal(""), z.string().trim().max(2000).refine((v) => /^https?:\/\/\S+$/i.test(v), "URLは http(s):// で始まる形式で入力してください")]).default("");
const sha = z.union([z.literal(""), z.string().regex(/^[0-9a-f]{64}$/)]).default("");
const path = z.union([z.literal(""), z.string().max(300).regex(/^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}$/, "画像の場所が正しくありません")]).default("");

export const cardInputSchema = z.object({
  name: z.string().trim().min(1, "カード名を入力してください").max(80, "カード名は80文字以内で入力してください"),
  cardNumber: text("カード番号", 20),
  setCode: text("商品コード", 20),
  rarity: text("レアリティ", 10),
  cardType: text("カードの種類", 30),
  productName: text("収録商品", 120),
  productId: z.uuid().nullable().default(null),
  imagePath: path,
  thumbPath: path,
  imageSha: sha,
  sourceUrl: url,
  analysisRunId: z.uuid().nullable().default(null),
});
export type CardInput = z.input<typeof cardInputSchema>;

export const holdingInputSchema = z.object({
  quantity: z.number().int("所持枚数は整数で入力してください").min(1, "所持枚数は1以上").max(9999, "所持枚数は9999以下"),
  acquiredOn: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "購入日の形式が正しくありません")]).default(""),
  /** 1枚あたりの購入価格（円）。空欄=不明 */
  unitPriceYen: z.number().int("購入金額は整数で入力してください").min(0, "購入金額は0円以上").max(100_000_000, "購入金額が大きすぎます").nullable().default(null),
  source: text("購入元", 60),
  condition: text("状態", 30),
  note: text("備考", 500),
  purchaseId: z.uuid().nullable().default(null),
});
export type HoldingInput = z.input<typeof holdingInputSchema>;

export const priceInputSchema = z.object({
  kind: z.enum(["sale", "buyback"]),
  amountYen: z.number().int("価格は整数で入力してください").min(0, "価格は0円以上").max(100_000_000, "価格が大きすぎます"),
  confirmedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "確認日の形式が正しくありません"),
  source: text("情報源", 60),
  sourceUrl: url,
});
export type PriceInput = z.input<typeof priceInputSchema>;

/** 購入金額の入力（空欄は null。カンマ・円記号は許す） */
export function parseYen(raw: string): number | null | "invalid" {
  const v = raw.normalize("NFKC").replace(/[,，\s円¥]/g, "");
  if (v === "") return null;
  return /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : "invalid";
}
