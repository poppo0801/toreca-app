import { isPast, sortKey } from "@/lib/datetime";
import { effectiveEventState, isSkippedBy } from "@/lib/eligibility";
import type { AppData, Application, Lottery, LotteryItem, Product } from "@/types/domain";

export type Tab = "managed" | "applied" | "won" | "all";
export type AllFilter = "any" | "unmanaged" | "skipped" | "history";
export type SortMode = "deadline" | "result";

/** ★管理対象タブのスルー表示: normal=自分がスルーしていないもの / include=すべて / only=自分がスルーしたもの */
export type SkipView = "normal" | "include" | "only";

export interface Filters {
  query: string;
  chainId: string;
  /** 商品で絞り込み（複数商品の抽選も、いずれかの明細に含まれていれば対象） */
  productId: string;
  skip: SkipView;
  prefecture: string;
  receiveMethod: string;
  allFilter: AllFilter;
  sort: SortMode;
}

export const DEFAULT_FILTERS: Filters = {
  query: "",
  chainId: "",
  productId: "",
  skip: "normal",
  prefecture: "",
  receiveMethod: "",
  allFilter: "any",
  sort: "deadline",
};

export function isManaged(data: AppData, lotteryId: string): boolean {
  return data.management.find((m) => m.lotteryId === lotteryId)?.isManaged ?? false;
}

function liveApplications(data: AppData, lotteryId: string): Application[] {
  return data.applications.filter((a) => a.lotteryId === lotteryId && a.state === "applied");
}

/** 結果待ち（未確認）の応募を持つか */
export function hasPendingResult(data: AppData, lotteryId: string): boolean {
  return liveApplications(data, lotteryId).some((a) => a.result === "pending");
}

export function hasWon(data: AppData, lotteryId: string): boolean {
  return liveApplications(data, lotteryId).some((a) => a.result === "won");
}

/** 発表予定を過ぎたのに結果が未登録 */
export function isResultOverdue(data: AppData, lottery: Lottery, now: Date): boolean {
  return hasPendingResult(data, lottery.id) && isPast(lottery.resultDate, now) === true;
}

export function isSkippedByAnyone(data: AppData, lotteryId: string): boolean {
  const l = data.lotteries.find((x) => x.id === lotteryId);
  if (!l) return false;
  return data.skipRules.some(
    (r) =>
      !r.exceptionLotteryIds.includes(l.id) &&
      ((r.scope === "lottery" && r.scopeId === l.id) ||
        (r.scope === "store" && r.scopeId === l.storeId) ||
        (r.scope === "chain" && r.scopeId === l.chainId)),
  );
}

/** 画面のタブは保存場所ではなく検索ビュー（database-schema.md §2）。 */
export function inTab(data: AppData, lottery: Lottery, tab: Tab, now: Date): boolean {
  const event = effectiveEventState(lottery, now);
  switch (tab) {
    case "managed":
      // 受付終了は自動整理。応募済みで結果待ちなら応募済みタブに残る。
      return isManaged(data, lottery.id) && (event === "open" || event === "before");
    case "applied":
      return hasPendingResult(data, lottery.id);
    case "won":
      return hasWon(data, lottery.id);
    case "all":
      return true;
  }
}

function matchFilters(data: AppData, lottery: Lottery, f: Filters): boolean {
  if (f.chainId && lottery.chainId !== f.chainId) return false;
  const store = data.stores.find((s) => s.id === lottery.storeId);
  if (f.prefecture && store?.prefecture !== f.prefecture) return false;
  if (f.receiveMethod && lottery.receiveMethod !== f.receiveMethod) return false;
  if (f.productId && !lottery.items.some((i) => i.productId === f.productId)) return false;
  const q = f.query.trim().toLowerCase();
  if (q) {
    const chain = data.chains.find((c) => c.id === lottery.chainId);
    const hay = [
      chain?.name,
      store?.name,
      store?.prefecture,
      lottery.memo,
      ...lottery.items.flatMap((i) => {
        const p = data.products.find((x) => x.id === i.productId);
        return p ? [p.officialName, p.code, ...p.aliases] : [];
      }),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function matchAllFilter(data: AppData, lottery: Lottery, f: AllFilter, now: Date): boolean {
  switch (f) {
    case "any":
      return true;
    case "unmanaged":
      return !isManaged(data, lottery.id);
    case "skipped":
      return isSkippedByAnyone(data, lottery.id);
    case "history":
      return ["closed", "cancelled"].includes(effectiveEventState(lottery, now));
  }
}

/** 最も早い結果待ち応募の観点から並べるための補助: 未確認の結果が期限超過なら最上位。 */
function appliedRank(data: AppData, l: Lottery, now: Date): number {
  if (isResultOverdue(data, l, now)) return 0;
  if (l.resultDate.precision === "unknown") return 2; // 発表日不明は末尾の要確認グループ
  return 1;
}

function wonRank(data: AppData, l: Lottery): number {
  const apps = liveApplications(data, l.id).filter((a) => a.result === "won");
  return apps.every((a) => a.fulfillment === "purchased") ? 1 : 0; // 完了済みは後ろ
}

/**
 * スルーはユーザー別。★管理対象タブでは、既定で「自分がスルーした抽選」を一覧から外す（他のユーザーには影響しない）。
 * profileId を渡さない場合（集計用途など）はスルーで絞らない。
 */
function matchSkipView(data: AppData, lottery: Lottery, f: Filters, tab: Tab, profileId?: string): boolean {
  if (tab !== "managed" || !profileId || f.skip === "include") return true;
  const skipped = isSkippedBy(data, profileId, lottery);
  return f.skip === "only" ? skipped : !skipped;
}

export function selectLotteries(data: AppData, tab: Tab, f: Filters, now: Date, profileId?: string): Lottery[] {
  const list = data.lotteries.filter(
    (l) =>
      inTab(data, l, tab, now) &&
      matchFilters(data, l, f) &&
      matchSkipView(data, l, f, tab, profileId) &&
      (tab !== "all" || matchAllFilter(data, l, f.allFilter, now)),
  );

  const byDeadline = (a: Lottery, b: Lottery) => sortKey(a.applyDeadline) - sortKey(b.applyDeadline);
  const byResult = (a: Lottery, b: Lottery) => sortKey(a.resultDate) - sortKey(b.resultDate);
  const safe = (n: number) => (Number.isNaN(n) ? 0 : n);

  return [...list].sort((a, b) => {
    if (tab === "applied") {
      const r = appliedRank(data, a, now) - appliedRank(data, b, now);
      return r !== 0 ? r : safe(byResult(a, b));
    }
    if (tab === "won") {
      const r = wonRank(data, a) - wonRank(data, b);
      return r !== 0 ? r : safe(sortKey(a.procedureDeadline) - sortKey(b.procedureDeadline));
    }
    return safe(f.sort === "result" ? byResult(a, b) : byDeadline(a, b));
  });
}

/** 数量のBOX/パック換算表示。商品ごとの入数を使い、固定30Pとしない。 */
export function formatItem(item: Pick<LotteryItem, "quantity" | "unit">, product: Product | undefined): string {
  const name = product?.aliases[0] ?? product?.officialName ?? "商品未登録";
  if (item.unit === "set") return `${name} ×${item.quantity}セット`;
  if (item.unit === "pack") return `${name} ${item.quantity}P`;
  // 仮登録の商品は入数が未確認のため、パック換算は表示しない（既定値を事実として見せない）
  const packs = product && !product.provisional && product.packsPerBox ? ` (${item.quantity * product.packsPerBox}P)` : "";
  return `${name} ${item.quantity}BOX${packs}`;
}
