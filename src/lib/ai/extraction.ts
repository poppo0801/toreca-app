import { z } from "zod";

/**
 * 抽選告知の読み取り結果（AI・モック共通の正規化済み形式）。
 * AIの出力は信用せず、ここで必ず検証・正規化する。不明な項目は「不明」のまま残し、推測で確定しない。
 * Stage 4C（定期自動収集）でも同じ形式を再利用する。
 */

export type Confidence = "high" | "medium" | "low";
export type MultiModeGuess = "single" | "all" | "one_win" | "choose_one" | "unknown";

export const FIELD_KEYS = [
  "chain",
  "store",
  "items",
  "multiMode",
  "applyStart",
  "applyDeadline",
  "resultDate",
  "procedureDeadline",
  "announcement",
  "applyMethod",
  "receiveMethod",
  "limit",
  "conditions",
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export interface ExtractedFlex {
  precision: "unknown" | "date_only" | "date_time";
  /** YYYY-MM-DD（JST） */
  date: string;
  /** HH:MM（JST） */
  time: string;
  /** 告知に年の記載がなく、年を補った */
  yearAssumed: boolean;
}

export interface ExtractedItem {
  name: string;
  code: string;
  quantity: number;
  unit: "box" | "pack" | "set";
  /** 告知に単位の記載がなく、BOXとしている */
  unitAssumed: boolean;
}

export interface ExtractedLottery {
  isLotteryAnnouncement: boolean;
  chainName: string;
  storeName: string;
  prefecture: string;
  items: ExtractedItem[];
  multiMode: MultiModeGuess;
  applyStart: ExtractedFlex;
  applyDeadline: ExtractedFlex;
  resultDate: ExtractedFlex;
  procedureDeadline: ExtractedFlex;
  announcementMethod: string;
  announcementUrl: string;
  applyUrl: string;
  applyMethod: "web" | "store" | "app" | "unknown";
  receiveMethod: "store" | "shipping" | "either" | "unknown";
  limitBasis: "account" | "person" | "family" | "address" | "unknown";
  limitMaxCount: number | null;
  purchaseLimitText: string;
  conditionsText: string;
  verificationText: string;
  notes: string;
  confidence: Record<FieldKey, Confidence>;
  warnings: string[];
}

const str = (max: number) => z.string().trim().max(max).catch("").default("");
const int = z.number().int().nullable().catch(null).default(null);

const rawDate = z
  .object({ year: int, month: int, day: int, hour: int, minute: int })
  .nullable()
  .catch(null)
  .default(null);

const conf = z.enum(["high", "medium", "low"]).catch("low").default("low");

/** AI出力の受け入れ用スキーマ（足りない項目・不正な値は安全側のデフォルトに倒す） */
export const rawExtractionSchema = z.object({
  is_lottery_announcement: z.boolean().catch(true).default(true),
  chain_name: str(80),
  store_name: str(80),
  prefecture: str(10),
  products: z
    .array(
      z.object({
        name: str(120),
        code: str(30),
        quantity: z.number().int().min(1).max(9999).catch(1).default(1),
        unit: z.enum(["box", "pack", "set"]).nullable().catch(null).default(null),
      }),
    )
    .catch([])
    .default([]),
  multi_mode: z.enum(["single", "all", "one_win", "choose_one", "unknown"]).catch("unknown").default("unknown"),
  apply_start: rawDate,
  apply_deadline: rawDate,
  result_date: rawDate,
  procedure_deadline: rawDate,
  announcement_method: str(200),
  announcement_url: str(2000),
  apply_url: str(2000),
  apply_method: z.enum(["web", "store", "app", "unknown"]).catch("unknown").default("unknown"),
  receive_method: z.enum(["store", "shipping", "either", "unknown"]).catch("unknown").default("unknown"),
  limit_basis: z.enum(["account", "person", "family", "address", "unknown"]).catch("unknown").default("unknown"),
  limit_max_count: z.number().int().min(1).max(99).nullable().catch(null).default(null),
  purchase_limit_text: str(500),
  conditions_text: str(2000),
  verification_text: str(1000),
  notes: str(1500),
  confidence: z
    .object({
      chain: conf,
      store: conf,
      products: conf,
      multi_mode: conf,
      apply_start: conf,
      apply_deadline: conf,
      result_date: conf,
      procedure_deadline: conf,
      announcement: conf,
      apply_method: conf,
      receive_method: conf,
      limit: conf,
      conditions: conf,
    })
    .catch({
      chain: "low", store: "low", products: "low", multi_mode: "low", apply_start: "low", apply_deadline: "low", result_date: "low",
      procedure_deadline: "low", announcement: "low", apply_method: "low", receive_method: "low", limit: "low", conditions: "low",
    })
    .default({
      chain: "low", store: "low", products: "low", multi_mode: "low", apply_start: "low", apply_deadline: "low", result_date: "low",
      procedure_deadline: "low", announcement: "low", apply_method: "low", receive_method: "low", limit: "low", conditions: "low",
    }),
  warnings: z.array(z.string().trim().max(300)).max(20).catch([]).default([]),
});
export type RawExtraction = z.infer<typeof rawExtractionSchema>;

const UNKNOWN_FLEX: ExtractedFlex = { precision: "unknown", date: "", time: "", yearAssumed: false };
const p2 = (n: number) => String(n).padStart(2, "0");

/** 実在する日付か（2/30 などを弾く） */
function validDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** JST の「今日」(YYYY-MM-DD) */
export function jstToday(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * AIが返した日時（年・時刻は欠けうる）を正規化する。
 * 年の記載がない場合は、今日から見て近い年を補い、yearAssumed=true として呼び出し側に注意表示させる。
 * 日付が不正、または今日から大きく離れた年は「不明」にする（推測で確定しない）。
 */
export function normalizeFlex(raw: z.infer<typeof rawDate>, now: Date, warnings: string[], label: string): ExtractedFlex {
  if (!raw || raw.month == null || raw.day == null) return UNKNOWN_FLEX;
  const today = jstToday(now);
  const thisYear = Number(today.slice(0, 4));
  let year = raw.year;
  let yearAssumed = false;
  if (year == null) {
    year = thisYear;
    // 今日より約2か月以上前の日付は翌年の告知とみなす（年またぎ）。あくまで仮定として注意表示する
    const candidate = Date.UTC(year, raw.month - 1, raw.day);
    const todayMs = Date.UTC(thisYear, Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
    if (candidate < todayMs - 60 * 86400_000) year = thisYear + 1;
    yearAssumed = true;
    warnings.push(`${label}: 年の記載がないため${year}年と仮定しました。確認してください`);
  } else if (year < thisYear - 1 || year > thisYear + 2) {
    warnings.push(`${label}: 年（${year}年）が現在から離れているため不明として扱いました`);
    return UNKNOWN_FLEX;
  }
  if (!validDate(year, raw.month, raw.day)) {
    warnings.push(`${label}: 存在しない日付のため不明として扱いました`);
    return UNKNOWN_FLEX;
  }
  const date = `${year}-${p2(raw.month)}-${p2(raw.day)}`;
  if (raw.hour != null && raw.hour >= 0 && raw.hour <= 23) {
    const minute = raw.minute != null && raw.minute >= 0 && raw.minute <= 59 ? raw.minute : 0;
    return { precision: "date_time", date, time: `${p2(raw.hour)}:${p2(minute)}`, yearAssumed };
  }
  return { precision: "date_only", date, time: "", yearAssumed };
}

const httpUrl = (v: string) => (/^https?:\/\/\S+$/i.test(v) ? v : "");

/** AIの生の出力 → 検証済みの ExtractedLottery */
export function normalizeExtraction(raw: unknown, now: Date): ExtractedLottery {
  const r = rawExtractionSchema.parse(raw && typeof raw === "object" ? raw : {});
  // AIが書いた注意のうち、内部用語（year・null）を含むものは、システム側の注意（年の補完など）と重複するので除く
  const warnings = r.warnings.filter((w) => !/(year|null)/i.test(w));
  const items: ExtractedItem[] = r.products
    .filter((p) => p.name.length > 0)
    .map((p) => ({ name: p.name, code: p.code, quantity: p.quantity, unit: p.unit ?? "box", unitAssumed: p.unit === null }));
  if (items.some((i) => i.unitAssumed)) warnings.push("商品の単位（BOX/パック/セット）が告知から読み取れないため、BOXとしています。確認してください");

  const c = r.confidence;
  return {
    isLotteryAnnouncement: r.is_lottery_announcement,
    chainName: r.chain_name,
    storeName: r.store_name,
    prefecture: r.prefecture,
    items,
    multiMode: items.length > 1 ? r.multi_mode : items.length === 1 ? "single" : "unknown",
    applyStart: normalizeFlex(r.apply_start, now, warnings, "応募開始"),
    applyDeadline: normalizeFlex(r.apply_deadline, now, warnings, "応募締切"),
    resultDate: normalizeFlex(r.result_date, now, warnings, "当選発表"),
    procedureDeadline: normalizeFlex(r.procedure_deadline, now, warnings, "購入・受取期限"),
    announcementMethod: r.announcement_method,
    announcementUrl: httpUrl(r.announcement_url),
    applyUrl: httpUrl(r.apply_url),
    applyMethod: r.apply_method,
    receiveMethod: r.receive_method,
    limitBasis: r.limit_basis,
    limitMaxCount: r.limit_max_count,
    purchaseLimitText: r.purchase_limit_text,
    conditionsText: r.conditions_text,
    verificationText: r.verification_text,
    notes: r.notes,
    confidence: {
      chain: c.chain,
      store: c.store,
      items: c.products,
      multiMode: c.multi_mode,
      applyStart: c.apply_start,
      applyDeadline: c.apply_deadline,
      resultDate: c.result_date,
      procedureDeadline: c.procedure_deadline,
      announcement: c.announcement,
      applyMethod: c.apply_method,
      receiveMethod: c.receive_method,
      limit: c.limit,
      conditions: c.conditions,
    },
    warnings,
  };
}

/** 何か1つでも読み取れたか（全項目が空なら「読み取れませんでした」と案内する） */
export function hasAnyContent(e: ExtractedLottery): boolean {
  return (
    e.chainName !== "" ||
    e.storeName !== "" ||
    e.items.length > 0 ||
    [e.applyStart, e.applyDeadline, e.resultDate, e.procedureDeadline].some((f) => f.precision !== "unknown") ||
    e.conditionsText !== "" ||
    e.applyUrl !== ""
  );
}
