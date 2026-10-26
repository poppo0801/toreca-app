import { z } from "zod";

/** 抽選外購入の入力定義（クライアントの事前検証とサーバー検証で共用）。不明は空欄/null で保存し、推測で埋めない。 */
export const manualPurchaseSchema = z.object({
  storeId: z.union([z.uuid(), z.literal("")]),
  /** 日付のみ判明なら date、時刻まで判明なら time も。両方空=日時不明 */
  date: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  time: z.union([z.literal(""), z.string().regex(/^\d{2}:\d{2}$/)]),
  channel: z.enum(["store", "shipping", "online", "other"]),
  note: z.string().trim().max(1000),
  items: z
    .array(
      z.object({
        productId: z.union([z.uuid(), z.literal("")]),
        quantity: z.number().int("数量は整数で入力してください").min(1, "数量は1以上で入力してください").max(9999),
        unit: z.enum(["box", "pack", "set"]),
        /** 不明は null（0円と区別する） */
        amountPaid: z.number().int().min(0).max(100_000_000).nullable(),
      }),
    )
    .min(1, "購入内容を1つ以上入力してください")
    .max(20),
});
export type ManualPurchaseInput = z.input<typeof manualPurchaseSchema>;
