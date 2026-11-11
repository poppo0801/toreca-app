/**
 * オンライン店舗の統一（Stage 7S・純関数）。
 *  - 内部: 店舗の営業形態 sales_kind = 'online_only'（オンライン専用）。標準の店舗名は「通販」
 *  - 「オンライン」「通販」「通販店」「ネットショップ」などの表記ゆれは、同じ系列内では同じオンライン店舗として扱う
 *  - 同一系列内のオンライン店舗は原則1件（独立した通販サイトが複数ある系列だけ、利用者が別管理にできる）
 *  - 表示名: 実店舗と通販が混在する系列は「系列名 通販」、通販しか無い系列は「系列名」だけ
 */
import { normName } from "@/lib/norm";

/** 店舗マスターでの標準の店舗名 */
export const ONLINE_STORE_NAME = "通販";

const ONLINE_NAMES = new Set(
  [
    "オンライン",
    "通販",
    "通販店",
    "通販サイト",
    "通販ショップ",
    "ネット通販",
    "ネットショップ",
    "ネットストア",
    "ネット店",
    "オンライン店",
    "オンラインストア",
    "オンラインショップ",
    "オンライン販売",
    "公式オンライン",
    "公式オンラインストア",
    "公式通販",
    "公式サイト",
    "公式ストア",
    "公式ショップ",
    "eストア",
    "webストア",
    "webショップ",
    "web",
    "ウェブ",
    "ウェブストア",
    "online",
    "onlinestore",
    "onlineshop",
  ].map(normName),
);

/** 店舗名が、店舗ではなく通販・オンラインの販売形態を表すか（系列名が先頭に付いた表記は、系列名を除いて判定する） */
export function isOnlineStoreName(name: string | null | undefined, chainName?: string | null): boolean {
  if (!name) return false;
  let k = normName(name);
  if (ONLINE_NAMES.has(k)) return true;
  const c = chainName ? normName(chainName) : "";
  if (c && k.startsWith(c) && k.length > c.length) {
    k = k.slice(c.length);
    return ONLINE_NAMES.has(k);
  }
  return false;
}

export interface OnlineCheckable {
  name: string;
  salesKind?: string | null;
}

/** オンライン店舗か（営業形態がオンライン専用、または名称がオンライン系の表記） */
export const isOnlineStore = (s: OnlineCheckable, chainName?: string | null): boolean => s.salesKind === "online_only" || isOnlineStoreName(s.name, chainName);

/**
 * 通販店舗の画面上の名称。実店舗と通販が混在する系列は「系列名 通販」、通販だけの系列は「系列名」。
 * chainStores は同じ系列の有効な店舗（応募時に店舗選択の仮の店舗は除く）。
 */
export function onlineStoreLabel(chainName: string, chainStores: OnlineCheckable[]): string {
  const hasPhysical = chainStores.some((s) => !isOnlineStore(s, chainName) && s.name !== "応募時に店舗選択");
  return hasPhysical ? `${chainName} ${ONLINE_STORE_NAME}` : chainName;
}

/** 抽選カード等の「系列 店舗」の表示。通販店舗は onlineStoreLabel、それ以外は「系列名 店舗名」 */
export function chainStoreLine(chainName: string, store: (OnlineCheckable & { archived?: boolean }) | null | undefined, chainStores: (OnlineCheckable & { archived?: boolean })[]): string {
  if (store && isOnlineStore(store, chainName)) return onlineStoreLabel(chainName, chainStores.filter((s) => !s.archived));
  return `${chainName} ${store?.name ?? ""}`.trim();
}
