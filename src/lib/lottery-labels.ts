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
