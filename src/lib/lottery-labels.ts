import type { ApplyMethod, EventState, MultiMode, ReceiveMethod, ResultStatus } from "@/types/domain";

export const MODE_LABEL: Record<MultiMode, string | null> = {
  single: null,
  all: "商品ごとに当落",
  one_win: "当選は1商品まで",
  choose_one: "1商品を選んで応募",
};

export const EVENT_LABEL: Record<EventState, string | null> = {
  before: "受付前",
  open: null,
  closed: "受付終了",
  cancelled: "中止",
  postponed: "発表延期",
};

/** 一覧用の短い表記 */
export const RECEIVE_SHORT: Record<ReceiveMethod, string> = {
  store: "店頭",
  shipping: "発送",
  either: "店頭/発送",
  unknown: "—",
};

export const RECEIVE_LABEL: Record<ReceiveMethod, string> = {
  store: "店頭受取",
  shipping: "発送",
  either: "店頭/発送",
  unknown: "未確認",
};

export const APPLY_LABEL: Record<ApplyMethod, string> = {
  web: "Web",
  store: "店頭",
  app: "アプリ",
  unknown: "未確認",
};

export const RESULT_LABEL: Record<ResultStatus, string> = {
  pending: "未確認",
  won: "当選",
  lost: "落選",
  unknown: "不明",
};

export const LEVEL_CLASS = {
  urgent: "border-danger text-danger",
  soon: "border-warn text-warn",
  today: "border-info text-info",
  normal: "text-muted-foreground",
  expired: "text-muted-foreground",
} as const;

export const LIMIT_BASIS_LABEL = { account: "1アカウント", person: "1人", family: "1家族", address: "1住所" } as const;

/**
 * 抽選カード右上の受取場所の表示。応募方法ではなく「受取方法」で決める。
 *  - 発送 → 「通販」（店舗が登録されていても）
 *  - 店頭 / 店頭か発送 → 受取店舗の都道府県（登録がなければ出さない）
 *  - 不明 → 出さない（推測で都道府県を出さない）
 */
export function placeLabel(receive: "store" | "shipping" | "either" | "unknown", prefecture: string | null | undefined): string | null {
  if (receive === "shipping") return "通販";
  if ((receive === "store" || receive === "either") && prefecture) return prefecture;
  return null;
}
