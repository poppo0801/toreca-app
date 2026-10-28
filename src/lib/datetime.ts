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
