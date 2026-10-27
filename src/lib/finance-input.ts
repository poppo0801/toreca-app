import { z } from "zod";

/** 収支入力の定義（クライアントの事前検証とサーバー検証で共用）。不明は null/空で保存し、推測で埋めない。 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付を入力してください");
const yen = z.number().int("金額は整数で入力してください").min(0, "金額は0以上で入力してください").max(100_000_000);
const optionalYen = yen.nullable();

/** マスター参照（既存を選択 = id、未登録の自由入力 = name） */
const ref = z.object({ id: z.uuid().nullable(), name: z.string().trim().max(120) });

export const expenseItemSchema = z.object({
  /** 編集時の既存明細ID */
  id: z.uuid().nullable().optional(),
  product: ref.refine((v) => v.id !== null || v.name.length > 0, "商品を選択または入力してください"),
  quantity: z.number().int("数量は整数で入力してください").min(1, "数量は1以上で入力してください").max(9999),
  unit: z.enum(["box", "pack", "set"]),
  /** 実際の購入金額。不明は null（0円と区別する） */
  amountPaid: optionalYen,
});

export const expenseSchema = z.object({
  date: dateStr,
  store: ref,
  channel: z.enum(["store", "shipping", "online", "other"]),
  note: z.string().trim().max(1000),
  items: z.array(expenseItemSchema).min(1, "購入内容を1つ以上入力してください").max(20),
});
export type ExpenseInput = z.input<typeof expenseSchema>;

export const saleSchema = z.object({
  soldOn: dateStr,
  platform: z.string().trim().max(80),
  product: ref.refine((v) => v.id !== null || v.name.length > 0, "商品を選択または入力してください"),
  quantity: z.number().int("数量は整数で入力してください").min(1, "数量は1以上で入力してください").max(9999),
  unit: z.enum(["box", "pack", "set", "piece"]),
  amount: yen,
  sellerProfileId: z.uuid("売却名義人を選択してください"),
  /** 原価。未設定は null（0円とはみなさない） */
  costAmount: optionalYen,
  /** 紐づけた購入明細と、その何個分か（同時に指定。重複計上はDBが防ぐ） */
  costPurchaseItemId: z.uuid().nullable(),
  costQuantity: z.number().int().min(1).max(9999).nullable(),
  fee: yen,
  shipping: yen,
  memo: z.string().trim().max(1000),
});
export type SaleInput = z.input<typeof saleSchema>;
