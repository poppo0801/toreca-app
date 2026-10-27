import { z } from "zod";
import type { FlexibleDate } from "@/types/domain";

/**
 * 抽選登録フォームの入力定義（クライアントの事前検証とサーバーの検証で共用）。
 * 日時は「不明 / 日付のみ / 日時」を明示的に選ばせ、時刻を推測で埋めない。
 */

export const FLEX_PRECISIONS = ["unknown", "date_only", "date_time"] as const;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付の形式が正しくありません");
const timeStr = z.string().regex(/^\d{2}:\d{2}$/, "時刻の形式が正しくありません");

/** フォーム上の日時入力。date/time は precision に応じて必須。 */
export const flexInputSchema = z
  .object({
    precision: z.enum(FLEX_PRECISIONS),
    date: z.string(),
    time: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.precision !== "unknown" && !dateStr.safeParse(v.date).success) {
      ctx.addIssue({ code: "custom", message: "日付を入力してください", path: ["date"] });
    }
    if (v.precision === "date_time" && !timeStr.safeParse(v.time).success) {
      ctx.addIssue({ code: "custom", message: "時刻を入力してください", path: ["time"] });
    }
  });
export type FlexInput = z.infer<typeof flexInputSchema>;

export const EMPTY_FLEX: FlexInput = { precision: "unknown", date: "", time: "" };

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => /^https?:\/\/\S+$/i.test(v), "URLは http(s):// で始まる形式で入力してください");

/**
 * マスター参照。既存マスターを選んだ場合は id、未登録の名称を自由入力した場合は id=null + name。
 * 名称が既存マスター（略称含む・全半角/空白差を無視）と一致するときはサーバー側で既存を使い、重複作成しない。
 */
const masterRef = (label: string, max: number) =>
  z
    .object({ id: z.uuid().nullable(), name: z.string().trim().max(max, `${label}は${max}文字以内で入力してください`) })
    .refine((v) => v.id !== null || v.name.length > 0, { message: `${label}を選択または入力してください` });

export const MULTI_MODES = ["single", "all", "one_win", "choose_one"] as const;

const itemSchema = z.object({
  /** 編集時の既存明細ID（当落・購入の紐づけを保つ） */
  id: z.uuid().nullable().optional(),
  product: masterRef("商品", 120),
  quantity: z.number().int().min(1, "数量は1以上").max(9999),
  unit: z.enum(["box", "pack", "set"]),
});

export const lotteryInputSchema = z.object({
  chain: masterRef("系列", 80),
  store: masterRef("店舗", 80).and(z.object({ prefecture: z.string().trim().max(10).default("") })),
  multiMode: z.enum(MULTI_MODES).default("single"),
  campaignId: z.uuid().nullable(),
  newCampaign: z
    .object({ name: z.string().trim().min(1, "キャンペーン名を入力してください").max(100), storeRule: z.enum(["one_store", "multi"]) })
    .nullable(),
  items: z.array(itemSchema).min(1, "商品を1つ以上追加してください").max(10),
  applyStart: flexInputSchema,
  applyDeadline: flexInputSchema,
  resultDate: flexInputSchema,
  procedureDeadline: flexInputSchema,
  receiveMethod: z.enum(["store", "shipping", "either", "unknown"]),
  applyMethod: z.enum(["web", "store", "app", "unknown"]),
  conditionsText: z.string().trim().max(2000),
  verificationText: z.string().trim().max(1000),
  announcementMethod: z.string().trim().max(200),
  announcementUrl: z.union([z.literal(""), httpUrl]),
  sourceUrls: z.array(httpUrl).max(10),
  eventState: z.enum(["before", "open", "cancelled", "postponed"]),
  limitBasis: z.enum(["account", "person", "family", "address", "unknown"]),
  limitMaxCount: z.number().int().min(1).max(99),
  memo: z.string().trim().max(2000),
  /** 新規登録時のみ。省略時はON */
  isManaged: z.boolean().optional(),
  /** 新規登録時のみ（過去抽選の応募済み・当落まで同時登録）。実際の応募日時が不明なら appliedAt は空 */
  applications: z
    .array(z.object({ profileId: z.uuid(), status: z.enum(["applied", "won", "lost"]) }))
    .max(50)
    .default([]),
  appliedAt: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)]).default(""),
});
export type LotteryInput = z.input<typeof lotteryInputSchema>;

/** 方式と明細数の整合（A=単一は1商品、B/C/Dは2商品以上） */
export function validateMultiMode(mode: (typeof MULTI_MODES)[number], itemCount: number): string | null {
  if (mode === "single" && itemCount > 1) return "単一商品の抽選には商品を1つだけ指定してください（複数商品の場合は方式を選択）";
  if (mode !== "single" && itemCount < 2) return "複数商品の抽選には商品を2つ以上指定してください";
  return null;
}
export type LotteryInputParsed = z.output<typeof lotteryInputSchema>;

/** JST の日付+時刻 → UTC ISO */
export function jstToIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

export interface DbFlex {
  precision: "unknown" | "date_only" | "date_time";
  date: string | null;
  at: string | null;
}

export function flexInputToDb(v: FlexInput): DbFlex {
  switch (v.precision) {
    case "unknown":
      return { precision: "unknown", date: null, at: null };
    case "date_only":
      return { precision: "date_only", date: v.date, at: null };
    case "date_time":
      return { precision: "date_time", date: null, at: jstToIso(v.date, v.time) };
  }
}

export function dbToFlex(precision: string, date: string | null, at: string | null): FlexibleDate {
  if (precision === "date_only" && date) return { precision: "date_only", date };
  if (precision === "date_time" && at) return { precision: "date_time", at };
  return { precision: "unknown" };
}

const jstParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** FlexibleDate → フォーム入力（編集時の初期値） */
export function flexToInput(v: FlexibleDate): FlexInput {
  if (v.precision === "date_only") return { precision: "date_only", date: v.date, time: "" };
  if (v.precision === "date_time") {
    const p = Object.fromEntries(jstParts.formatToParts(new Date(v.at)).map((x) => [x.type, x.value]));
    return { precision: "date_time", date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  return EMPTY_FLEX;
}
