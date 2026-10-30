import type { FlexibleDate } from "@/types/domain";

const TZ = "Asia/Tokyo";

/** 残り時間バッジの段階（将来は設定画面の値に置き換える） */
export const REMAINING_THRESHOLDS_MIN = { urgent: 30, soon: 180, today: 1440 } as const;

const jstDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const jstPartsFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: TZ,
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** JSTの暦日 YYYY-MM-DD */
export function jstDateString(d: Date): string {
  return jstDateFormat.format(d);
}

export function dateOnly(date: string): FlexibleDate {
  return { precision: "date_only", date };
}

export function dateTime(at: string): FlexibleDate {
  return { precision: "date_time", at };
}

export const UNKNOWN_DATE: FlexibleDate = { precision: "unknown" };

/**
 * 期限が過ぎたか。判定不能（unknown）は null を返し、過ぎたと仮定しない。
 * date_only は JST の当日終了までは「過ぎていない」とみなす。
 */
export function isPast(value: FlexibleDate, now: Date): boolean | null {
  switch (value.precision) {
    case "unknown":
      return null;
    case "date_only":
      return jstDateString(now) > value.date;
    case "date_time":
      return new Date(value.at).getTime() < now.getTime();
  }
}

/** ソート用キー。不明は末尾に回すため Infinity。date_only はその日のJST終了時刻扱い（表示には使わない）。 */
export function sortKey(value: FlexibleDate): number {
  switch (value.precision) {
    case "unknown":
      return Number.POSITIVE_INFINITY;
    case "date_only":
      return new Date(`${value.date}T23:59:59+09:00`).getTime();
    case "date_time":
      return new Date(value.at).getTime();
  }
}

/** 表示用。日付のみは「mm/dd（時刻未確認）」。 */
export function formatFlexible(value: FlexibleDate): string {
  switch (value.precision) {
    case "unknown":
      return "未確認";
    case "date_only": {
      const [, m, d] = value.date.split("-");
      return `${Number(m)}/${Number(d)}（時刻未確認）`;
    }
    case "date_time": {
      const parts = jstPartsFormat.formatToParts(new Date(value.at));
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
    }
  }
}

/**
 * 一覧用の短い表記。不明は「—」、日付のみは「10/27」（時刻は出さない）、日時は「10/27 21:00」。
 * 時刻なしと 0:00 は区別される（0:00 は「10/27 0:00」と表示される）。
 */
export function formatShort(value: FlexibleDate): string {
  switch (value.precision) {
    case "unknown":
      return "—";
    case "date_only": {
      const [, m, d] = value.date.split("-");
      return `${Number(m)}/${Number(d)}`;
    }
    case "date_time": {
      const parts = jstPartsFormat.formatToParts(new Date(value.at));
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      return `${get("month")}/${get("day")} ${Number(get("hour"))}:${get("minute")}`;
    }
  }
}

export type RemainingLevel = "urgent" | "soon" | "today" | "normal" | "expired";

export interface Remaining {
  label: string;
  level: RemainingLevel;
}

/**
 * 残り時間バッジ。時刻まで判明している(date_time)場合のみ算出する。
 * date_only / unknown では架空の時刻を使わず null を返す。
 */
export function remainingBadge(value: FlexibleDate, now: Date): Remaining | null {
  if (value.precision !== "date_time") return null;
  const diffMin = Math.floor((new Date(value.at).getTime() - now.getTime()) / 60000);
  if (diffMin < 0) return { label: "締切済み", level: "expired" };
  const level: RemainingLevel =
    diffMin <= REMAINING_THRESHOLDS_MIN.urgent
      ? "urgent"
      : diffMin <= REMAINING_THRESHOLDS_MIN.soon
        ? "soon"
        : diffMin <= REMAINING_THRESHOLDS_MIN.today
          ? "today"
          : "normal";
  if (diffMin < 60) return { label: `あと${diffMin}分`, level };
  if (diffMin < 1440) return { label: `あと${Math.floor(diffMin / 60)}時間`, level };
  return { label: `あと${Math.floor(diffMin / 1440)}日`, level };
}

// ------------------------------------------------------------------ 応募締切の残り時間（カード・シンプル表示・詳細で共通）
export type DeadlineTone = "normal" | "warn" | "danger" | "ended";

export interface DeadlineBadge {
  label: string;
  tone: DeadlineTone;
  /** 日付のみ（時刻が未確認）で、日数だけで見積もった表示 */
  dateOnly: boolean;
}

const DAY_MS = 86_400_000;
const dayNumber = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

/**
 * 応募締切までの残り時間バッジ。段階: 3日以上=normal / 3日未満=warn / 24時間未満=danger / 終了=ended。
 * 時刻まで分かる(date_time)場合は分・時間・日で正確に出す。日付のみ(date_only)は時刻を補わず、
 * 「本日まで」「あとN日」と日付の差だけで示す（dateOnly=true）。不明は null。
 */
export function deadlineBadge(value: FlexibleDate, now: Date): DeadlineBadge | null {
  if (value.precision === "unknown") return null;
  if (value.precision === "date_only") {
    const diff = dayNumber(value.date) - dayNumber(jstDateString(now));
    if (diff < 0) return { label: "締切済み", tone: "ended", dateOnly: true };
    if (diff === 0) return { label: "本日まで", tone: "danger", dateOnly: true };
    return { label: `あと${diff}日`, tone: diff < 3 ? "warn" : "normal", dateOnly: true };
  }
  const diffMin = Math.floor((new Date(value.at).getTime() - now.getTime()) / 60000);
  if (diffMin < 0) return { label: "締切済み", tone: "ended", dateOnly: false };
  if (diffMin < 60) return { label: `あと${diffMin}分`, tone: "danger", dateOnly: false };
  if (diffMin < 1440) return { label: `あと${Math.floor(diffMin / 60)}時間`, tone: "danger", dateOnly: false };
  return { label: `あと${Math.floor(diffMin / 1440)}日`, tone: diffMin < 3 * 1440 ? "warn" : "normal", dateOnly: false };
}

// ------------------------------------------------------------------ 当落発表の期間（開始 = resultDate、最終日 = resultEndDate）
interface ResultPeriod {
  resultDate: FlexibleDate;
  resultEndDate?: string;
}

/** 発表開始の暦日(JST)。不明は null */
export function resultStartDay(l: ResultPeriod): string | null {
  const v = l.resultDate;
  if (v.precision === "date_only") return v.date;
  if (v.precision === "date_time") return jstDateString(new Date(v.at));
  return null;
}

/** 発表最終日(JST)。期間指定がなければ開始日（単一日の発表）。不明は null */
export function resultEndDay(l: ResultPeriod): string | null {
  const s = resultStartDay(l);
  if (!s) return null;
  return l.resultEndDate && l.resultEndDate > s ? l.resultEndDate : s;
}

export function hasResultPeriod(l: ResultPeriod): boolean {
  const s = resultStartDay(l);
  return !!s && !!l.resultEndDate && l.resultEndDate > s;
}

/**
 * 発表がすべて終わったか（期間なら最終日の翌日になってから）。判定不能は null。
 * 単一の発表日は従来どおり（日時なら時刻を過ぎたら、日付のみなら当日が終わったら）。
 */
export function isResultFinished(l: ResultPeriod, now: Date): boolean | null {
  if (!hasResultPeriod(l)) return isPast(l.resultDate, now);
  return jstDateString(now) > resultEndDay(l)!;
}

/** 発表期間の途中か（開始済みで最終日を過ぎていない） */
export function isResultInPeriod(l: ResultPeriod, now: Date): boolean {
  if (!hasResultPeriod(l)) return false;
  const today = jstDateString(now);
  const s = l.resultDate.precision === "date_time" ? new Date(l.resultDate.at).getTime() <= now.getTime() : today >= resultStartDay(l)!;
  return s && today <= resultEndDay(l)!;
}

/** 発表開始の並び替えキー（期間でも開始日基準）。不明は末尾 */
export function resultSortKey(l: ResultPeriod): number {
  return sortKey(l.resultDate);
}

/** 「11/7」「2027/1/10」（今年以外は年つき）。日付 YYYY-MM-DD から */
export function formatMonthDay(ymd: string, now: Date): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const thisYear = Number(jstDateString(now).slice(0, 4));
  return y === thisYear ? `${m}/${d}` : `${y}/${m}/${d}`;
}

/** 発表日の短い表記。単一「11/7」「11/7 12:00」、期間「11/7〜11/10」、不明「—」。今年以外は年つき */
export function formatResultShort(l: ResultPeriod, now: Date): string {
  const s = resultStartDay(l);
  if (!s) return "—";
  const v = l.resultDate;
  const time = v.precision === "date_time" ? ` ${formatShort(v).split(" ")[1]}` : "";
  const start = `${formatMonthDay(s, now)}${time}`;
  return hasResultPeriod(l) ? `${start}〜${formatMonthDay(resultEndDay(l)!, now)}` : start;
}
