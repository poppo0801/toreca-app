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
  "procedureStart",
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
  /** 告知に年の記載がなく、年を補った（記録用。補った年が自然なら利用者への注意は出さない） */
  yearAssumed: boolean;
  /** 補った年が不確か（基準日から離れている・日付の前後関係と合わない・過去の日付など）。このときだけ要確認にする */
  yearUncertain: boolean;
}

/** 根拠の抜粋の対象（確認項目＋URL） */
export const EVIDENCE_KEYS = [...FIELD_KEYS, "applyUrl", "announcementUrl"] as const;
export type EvidenceKey = (typeof EVIDENCE_KEYS)[number];

/** 項目の根拠: 原文の短い抜粋。verified は、抜粋が原文（文章・取得したページ）に実在するか。画像など照合できない入力は null */
export interface EvidenceItem {
  quote: string;
  verified: boolean | null;
}

/** プログラム側の検証で見つかった注意（矛盾・原文に無い値など）。値を創作せず、該当項目を「要確認」にする */
export interface ExtractionIssue {
  field: EvidenceKey | "general";
  message: string;
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
  procedureStart: ExtractedFlex;
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
  /** 主要項目の根拠（原文の短い抜粋）。AIの申告であり、原文との照合結果を verified に持つ */
  evidence: Partial<Record<EvidenceKey, EvidenceItem>>;
  /** 年の推定に使った告知の公開日・投稿日（YYYY-MM-DD）。不明は空 */
  postedOn: string;
  issues: ExtractionIssue[];
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
  procedure_start: rawDate,
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
      procedure_start: conf,
      procedure_deadline: conf,
      announcement: conf,
      apply_method: conf,
      receive_method: conf,
      limit: conf,
      conditions: conf,
    })
    .catch({
      chain: "low", store: "low", products: "low", multi_mode: "low", apply_start: "low", apply_deadline: "low", result_date: "low",
      procedure_start: "low", procedure_deadline: "low", announcement: "low", apply_method: "low", receive_method: "low", limit: "low", conditions: "low",
    })
    .default({
      chain: "low", store: "low", products: "low", multi_mode: "low", apply_start: "low", apply_deadline: "low", result_date: "low",
      procedure_start: "low", procedure_deadline: "low", announcement: "low", apply_method: "low", receive_method: "low", limit: "low", conditions: "low",
    }),
  warnings: z.array(z.string().trim().max(300)).max(20).catch([]).default([]),
  /** 項目ごとの原文の抜粋（キーは evidence_keys）。余計なキー・長すぎる値は捨てる */
  evidence: z.record(z.string(), z.unknown()).catch({}).default({}),
  /** 告知の公開日・投稿日（書かれていれば）。年があるときだけ年の推定に使う */
  published_on: rawDate,
});
export type RawExtraction = z.infer<typeof rawExtractionSchema>;

const UNKNOWN_FLEX: ExtractedFlex = { precision: "unknown", date: "", time: "", yearAssumed: false, yearUncertain: false };

/** AI出力のevidenceキー（スネークケース）→ 内部キー */
const EVIDENCE_RAW_KEYS: Record<string, EvidenceKey> = {
  chain: "chain",
  store: "store",
  products: "items",
  multi_mode: "multiMode",
  apply_start: "applyStart",
  apply_deadline: "applyDeadline",
  result_date: "resultDate",
  procedure_start: "procedureStart",
  procedure_deadline: "procedureDeadline",
  announcement: "announcement",
  apply_method: "applyMethod",
  receive_method: "receiveMethod",
  limit: "limit",
  conditions: "conditions",
  apply_url: "applyUrl",
  announcement_url: "announcementUrl",
};
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

const DAY = 86400_000;
const dayMs = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

export interface YearContext {
  /** 基準日（告知の公開日・投稿日があればそれ、なければ今日）。YYYY-MM-DD */
  refDate: string;
  /** 基準日が告知の公開日・投稿日か（今日ではないか） */
  hasPosted: boolean;
}

/**
 * 年が書かれていない日付の年を決める。
 *  - 年が書かれていれば、その年を使う。
 *  - 書かれていなければ、基準日（告知の公開日・投稿日、なければ今日）に最も近い年を選ぶ（過去の告知を無条件に翌年へ動かさない）。
 *  - 直前の日付（応募開始→締切→発表→購入期限の順）があれば、その日付以降で最も早い年を選び、年またぎ（12月→1月）を自然に解釈する。
 * 判断が不確かなときだけ uncertain=true（要確認）にする。
 */
export function resolveYear(
  raw: { year: number | null; month: number; day: number },
  ctx: YearContext,
  prevMs: number | null,
): { year: number; assumed: boolean; uncertain: boolean } {
  if (raw.year != null) return { year: raw.year, assumed: false, uncertain: false };
  const refMs = dayMs(Number(ctx.refDate.slice(0, 4)), Number(ctx.refDate.slice(5, 7)), Number(ctx.refDate.slice(8, 10)));
  const refYear = Number(ctx.refDate.slice(0, 4));
  const valid = [refYear - 1, refYear, refYear + 1].filter((y) => validDate(y, raw.month, raw.day));
  if (valid.length === 0) return { year: refYear, assumed: true, uncertain: true };
  let year = valid.reduce((best, y) => (Math.abs(dayMs(y, raw.month, raw.day) - refMs) < Math.abs(dayMs(best, raw.month, raw.day) - refMs) ? y : best), valid[0]);
  if (prevMs !== null) {
    const prevYear = new Date(prevMs).getUTCFullYear();
    const seq = [prevYear, prevYear + 1].find((y) => validDate(y, raw.month, raw.day) && dayMs(y, raw.month, raw.day) >= prevMs);
    if (seq !== undefined && dayMs(seq, raw.month, raw.day) - prevMs <= 200 * DAY) year = seq;
  }
  const ms = dayMs(year, raw.month, raw.day);
  const uncertain = (prevMs !== null && ms < prevMs) || Math.abs(ms - refMs) > 150 * DAY || (!ctx.hasPosted && ms < refMs - 60 * DAY);
  return { year, assumed: true, uncertain };
}

/**
 * AIが返した日時（年・時刻は欠けうる）を正規化する。
 * 年の補完（resolveYear）と、原文にない時刻を補わないこと（時刻が無ければ日付のみ）は別の問題として扱う。
 * 日付が不正、または今日から大きく離れた年は「不明」にする（推測で確定しない）。
 */
export function normalizeFlex(raw: z.infer<typeof rawDate>, now: Date, warnings: string[], label: string, ctx?: YearContext, prevMs: number | null = null): ExtractedFlex {
  if (!raw || raw.month == null || raw.day == null) return UNKNOWN_FLEX;
  const today = jstToday(now);
  const thisYear = Number(today.slice(0, 4));
  const yc = ctx ?? { refDate: today, hasPosted: false };
  const r = resolveYear({ year: raw.year, month: raw.month, day: raw.day }, yc, prevMs);
  const year = r.year;
  if (raw.year != null && (year < thisYear - 1 || year > thisYear + 2)) {
    warnings.push(`${label}: 年（${year}年）が現在から離れているため不明として扱いました`);
    return UNKNOWN_FLEX;
  }
  if (!validDate(year, raw.month, raw.day)) {
    warnings.push(`${label}: 存在しない日付のため不明として扱いました`);
    return UNKNOWN_FLEX;
  }
  if (r.assumed && r.uncertain) warnings.push(`${label}: 年の記載がないため${year}年と推定しました。確認してください`);
  const date = `${year}-${p2(raw.month)}-${p2(raw.day)}`;
  if (raw.hour != null && raw.hour >= 0 && raw.hour <= 23) {
    const minute = raw.minute != null && raw.minute >= 0 && raw.minute <= 59 ? raw.minute : 0;
    return { precision: "date_time", date, time: `${p2(raw.hour)}:${p2(minute)}`, yearAssumed: r.assumed, yearUncertain: r.assumed && r.uncertain };
  }
  return { precision: "date_only", date, time: "", yearAssumed: r.assumed, yearUncertain: r.assumed && r.uncertain };
}

const httpUrl = (v: string) => (/^https?:\/\/\S+$/i.test(v) ? v : "");

/** AIの生の出力 → 検証済みの ExtractedLottery */
export function normalizeExtraction(raw: unknown, now: Date, opts: { postedOn?: string } = {}): ExtractedLottery {
  const r = rawExtractionSchema.parse(raw && typeof raw === "object" ? raw : {});
  // AIが書いた注意のうち、内部用語（year・null）を含むものは、システム側の注意（年の補完など）と重複するので除く
  const warnings = r.warnings.filter((w) => !/(year|null)/i.test(w));
  const items: ExtractedItem[] = r.products
    .filter((p) => p.name.length > 0)
    .map((p) => ({ name: p.name, code: p.code, quantity: p.quantity, unit: p.unit ?? "box", unitAssumed: p.unit === null }));
  if (items.some((i) => i.unitAssumed)) warnings.push("商品の単位（BOX/パック/セット）が告知から読み取れないため、BOXとしています。確認してください");

  // 年の推定の基準日: 取得した公開日・投稿日 → AIが読み取った公開日（年つき） → 今日
  const aiPosted =
    r.published_on && r.published_on.year != null && r.published_on.month != null && r.published_on.day != null && validDate(r.published_on.year, r.published_on.month, r.published_on.day)
      ? `${r.published_on.year}-${p2(r.published_on.month)}-${p2(r.published_on.day)}`
      : "";
  const postedOn = /^\d{4}-\d{2}-\d{2}$/.test(opts.postedOn ?? "") ? (opts.postedOn as string) : aiPosted;
  const yctx: YearContext = { refDate: postedOn || jstToday(now), hasPosted: postedOn !== "" };
  const evidence: ExtractedLottery["evidence"] = {};
  for (const [k, v] of Object.entries(r.evidence)) {
    const key = EVIDENCE_RAW_KEYS[k];
    if (key && typeof v === "string" && v.trim()) evidence[key] = { quote: v.trim().slice(0, 200), verified: null };
  }
  // 日付は 応募開始 → 締切 → 発表 → 購入期限 の順に、直前の日付との前後関係も使って年を決める
  const dates: ExtractedFlex[] = [];
  let prevMs: number | null = null;
  for (const [rawDate_, label] of [
    [r.apply_start, "応募開始"],
    [r.apply_deadline, "応募締切"],
    [r.result_date, "当選発表"],
    [r.procedure_start, "購入・受取開始"],
    [r.procedure_deadline, "購入・受取終了"],
  ] as const) {
    const f = normalizeFlex(rawDate_, now, warnings, label, yctx, prevMs);
    dates.push(f);
    if (f.precision !== "unknown") prevMs = dayMs(Number(f.date.slice(0, 4)), Number(f.date.slice(5, 7)), Number(f.date.slice(8, 10)));
  }
  const c = r.confidence;
  return {
    isLotteryAnnouncement: r.is_lottery_announcement,
    chainName: r.chain_name,
    storeName: r.store_name,
    prefecture: r.prefecture,
    items,
    multiMode: items.length > 1 ? r.multi_mode : items.length === 1 ? "single" : "unknown",
    applyStart: dates[0],
    applyDeadline: dates[1],
    resultDate: dates[2],
    procedureStart: dates[3],
    procedureDeadline: dates[4],
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
      procedureStart: c.procedure_start,
      procedureDeadline: c.procedure_deadline,
      announcement: c.announcement,
      applyMethod: c.apply_method,
      receiveMethod: c.receive_method,
      limit: c.limit,
      conditions: c.conditions,
    },
    warnings,
    evidence,
    postedOn,
    issues: [],
  };
}

/** 何か1つでも読み取れたか（全項目が空なら「読み取れませんでした」と案内する） */
export function hasAnyContent(e: ExtractedLottery): boolean {
  return (
    e.chainName !== "" ||
    e.storeName !== "" ||
    e.items.length > 0 ||
    [e.applyStart, e.applyDeadline, e.resultDate, e.procedureStart, e.procedureDeadline].some((f) => f.precision !== "unknown") ||
    e.conditionsText !== "" ||
    e.applyUrl !== ""
  );
}
