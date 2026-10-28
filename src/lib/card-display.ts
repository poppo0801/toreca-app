/**
 * 抽選カードに表示する項目の設定（家族共通）。
 * 応募締切が近い警告・未対応の通知・★・ユーザー別の応募状況の操作は、この設定とは別に常に表示する。
 */

export const CARD_FIELDS = ["prefecture", "distance", "travelCost", "deadline", "announce", "receive", "applyMethod", "quantity", "accounts"] as const;
export type CardField = (typeof CARD_FIELDS)[number];
export type CardDisplay = Record<CardField, boolean>;

export const CARD_FIELD_LABEL: Record<CardField, string> = {
  prefecture: "都道府県",
  distance: "自宅からの直線距離",
  travelCost: "往復交通費",
  deadline: "応募締切",
  announce: "当選発表日時",
  receive: "受取方法",
  applyMethod: "応募方法",
  quantity: "購入数量",
  accounts: "ユーザー別の応募状況",
};

/** 既定は重要な項目だけ（交通費・応募方法は非表示） */
export const DEFAULT_CARD_DISPLAY: CardDisplay = {
  prefecture: true,
  distance: true,
  travelCost: false,
  deadline: true,
  announce: true,
  receive: true,
  applyMethod: false,
  quantity: true,
  accounts: true,
};

/** 保存値を検証して補完する（未知のキーは捨て、欠けたキーは既定値） */
export function normalizeCardDisplay(raw: unknown): CardDisplay {
  const out = { ...DEFAULT_CARD_DISPLAY };
  if (raw && typeof raw === "object") {
    for (const k of CARD_FIELDS) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}
