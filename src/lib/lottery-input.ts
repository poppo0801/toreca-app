import { z } from "zod";
import type { FlexibleDate } from "@/types/domain";
import { ANNOUNCE_METHODS, REQUIREMENT_TAGS, sanitizeRequirementDetails } from "@/lib/lottery-taxonomy";

const ANNOUNCE_CODES = ANNOUNCE_METHODS.map((m) => m.code) as [string, ...string[]];
const REQUIREMENT_CODES = REQUIREMENT_TAGS.map((t) => t.code) as [string, ...string[]];
/** 未知のキー・不正な値は落とす（不明な数値は保存しない） */
const requirementDetailsSchema = z.unknown().transform((v) => sanitizeRequirementDetails(v));

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
    // 時刻だけが入力されている（日付が空）状態は、時刻を捨てて保存してしまわないよう受け付けない
    if (v.precision === "unknown" && v.time.trim() !== "") {
      ctx.addIssue({ code: "custom", message: "時刻だけでは登録できません。日付も入力してください", path: ["date"] });
    }
    if (v.precision !== "unknown" && !dateStr.safeParse(v.date).success) {
      ctx.addIssue({ code: "custom", message: "日付を入力してください", path: ["date"] });
    }
    if (v.precision === "date_time" && !timeStr.safeParse(v.time).success) {
      ctx.addIssue({ code: "custom", message: "時刻を入力してください", path: ["time"] });
    }
  });
export type FlexInput = z.infer<typeof flexInputSchema>;

export const EMPTY_FLEX: FlexInput = { precision: "unknown", date: "", time: "" };

/**
 * 日付欄・時刻欄の入力から精度を決める。空欄=不明 / 日付のみ=日付のみ / 日付+時刻=日時。
 * 時刻が入力されていれば（0:00 を含めて）日時、空なら日付のみ。時刻を推測で補わない（23:59 などにしない）。
 */
export function flexFromParts(date: string, time: string): FlexInput {
  const d = date.trim();
  const t = time.trim();
  if (!d) return { precision: "unknown", date: "", time: t };
  return { precision: t ? "date_time" : "date_only", date: d, time: t };
}

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

/** 初期値を設定する項目（初期値のまま保存された場合は「未確認」として記録する） */
export const UNCONFIRMABLE_FIELDS = ["applyMethod", "receiveMethod", "limitBasis"] as const;

const itemSchema = z.object({
  /** 編集時の既存明細ID（当落・購入の紐づけを保つ） */
  id: z.uuid().nullable().optional(),
  product: masterRef("商品", 120),
  quantity: z.number().int().min(1, "数量は1以上").max(9999),
  unit: z.enum(["box", "pack", "set", "piece"]),
});

export const lotteryInputSchema = z.object({
  chain: masterRef("系列", 80),
  /**
   * 店舗は任意。空（id=null・名称なし）は「店舗なし」で、系列だけで抽選を登録する（単独店舗の系列・オンラインストアなど）。ダミーの店舗は作らない。
   * 自動収集の下書きでは、空の店舗は「読み取れていない」（要確認）として扱う。意図して店舗なしにしたときは noStore を立てる。
   */
  store: z.object({ id: z.uuid().nullable(), name: z.string().trim().max(80, "店舗は80文字以内で入力してください") }).and(z.object({ prefecture: z.string().trim().max(10).default("") })),
  noStore: z.boolean().optional(),
  multiMode: z.enum(MULTI_MODES).default("single"),
  campaignId: z.uuid().nullable(),
  newCampaign: z
    .object({ name: z.string().trim().min(1, "キャンペーン名を入力してください").max(100), storeRule: z.enum(["one_store", "multi"]) })
    .nullable(),
  items: z.array(itemSchema).min(1, "商品を1つ以上追加してください").max(10),
  applyStart: flexInputSchema,
  applyDeadline: flexInputSchema,
  resultDate: flexInputSchema,
  /** 当選発表の最終日（期間指定のときだけ。空 = 単一の発表日） */
  resultEndDate: z.union([z.literal(""), dateStr]).default(""),
  procedureStart: flexInputSchema.default({ precision: "unknown", date: "", time: "" }),
  procedureDeadline: flexInputSchema,
  /** 購入期間と受取期間を分ける（分けないときは procedure* が購入・受取の共通期間）。分離時は procedure* が購入、receive* が受取 */
  procedureSplit: z.boolean().default(false),
  receiveStart: flexInputSchema.default({ precision: "unknown", date: "", time: "" }),
  receiveDeadline: flexInputSchema.default({ precision: "unknown", date: "", time: "" }),
  /** 抽選方式と、継続・招待の有効期限（告知にあるときだけ） */
  lotteryKind: z.enum(["normal", "ongoing", "invite"]).default("normal"),
  validUntil: z.union([z.literal(""), dateStr]).default(""),
  receiveMethod: z.enum(["store", "shipping", "either", "unknown"]),
  applyMethod: z.enum(["web", "store", "app", "unknown"]),
  conditionsText: z.string().trim().max(2000),
  verificationText: z.string().trim().max(1000),
  /** 当落発表方法の補足・原文（標準分類は announcementMethods） */
  announcementMethod: z.string().trim().max(200),
  announcementMethods: z.array(z.enum(ANNOUNCE_CODES)).max(12).default([]),
  announcementTarget: z.enum(["unknown", "both", "winners_only"]).default("unknown"),
  /** ルールによる推定（告知に明記が無い）。利用者が方法を選び直すと外れる */
  announcementInferred: z.boolean().default(false),
  /** 応募条件の標準分類。補足・原文は conditionsText */
  requirementTags: z.array(z.enum(REQUIREMENT_CODES)).max(28).default([]),
  requirementLogic: z.enum(["and", "or"]).default("and"),
  requirementDetails: requirementDetailsSchema.default({}),
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
  /** 初期値のまま（利用者が選んでいない）の項目。確認済みとは区別して保存する */
  unconfirmedFields: z.array(z.enum(UNCONFIRMABLE_FIELDS)).max(UNCONFIRMABLE_FIELDS.length).default([]),
  /**
   * AI読み取りの結果から登録するとき（新規登録のみ）。解析の実行ID・フォームに入力した直後の値・任意の修正理由。
   * 保存時に、AIの抽出結果との比較を1回だけ記録する（登録後の通常編集では記録しない）。
   */
  aiFeedback: z
    .object({
      runId: z.uuid(),
      filled: z.record(z.string(), z.unknown()),
      reason: z.enum(["ai_wrong", "other_source", "official_name", "other"]).nullable().default(null),
    })
    .optional(),
}).superRefine((v, ctx) => {
  // 購入・受取の期間: 開始が終了より後ろなら保存できない（日付のみ・日時が混在するときは日付で比べる）
  const s = v.procedureStart;
  const e = v.procedureDeadline;
  if (s.precision !== "unknown" && e.precision !== "unknown" && s.date && e.date) {
    const both = s.precision === "date_time" && e.precision === "date_time";
    const a = both ? `${s.date}T${s.time}` : s.date;
    const b = both ? `${e.date}T${e.time}` : e.date;
    if (a > b) ctx.addIssue({ code: "custom", message: "購入・受取の開始が終了より後になっています", path: ["procedureStart"] });
  }
  // 分離時の受取期間も同様に、開始が終了より後ろなら保存できない
  if (v.procedureSplit) {
    const rs = v.receiveStart;
    const re = v.receiveDeadline;
    if (rs.precision !== "unknown" && re.precision !== "unknown" && rs.date && re.date) {
      const both = rs.precision === "date_time" && re.precision === "date_time";
      if ((both ? `${rs.date}T${rs.time}` : rs.date) > (both ? `${re.date}T${re.time}` : re.date)) ctx.addIssue({ code: "custom", message: "受取の開始が終了より後になっています", path: ["receiveStart"] });
    }
  }
  // 当選発表の期間: 開始日が必要で、最終日は開始日以降
  if (v.resultEndDate) {
    if (v.resultDate.precision === "unknown" || !v.resultDate.date) {
      ctx.addIssue({ code: "custom", message: "発表の終了日を入れるときは、開始日も入力してください", path: ["resultEndDate"] });
    } else if (v.resultEndDate < v.resultDate.date) {
      ctx.addIssue({ code: "custom", message: "発表の終了日が開始日より前になっています", path: ["resultEndDate"] });
    }
  }
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
