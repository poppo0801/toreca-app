import { isResultFinished, resultSortKey, sortKey } from "@/lib/datetime";
import { effectiveEventState, isSkippedBy } from "@/lib/eligibility";
import { applyControlFor } from "@/lib/lottery-summary";
import { kindOf, myApplication, resultStage, wonProgress, wonSortRank } from "@/lib/lottery-flow";
import type { AppData, Application, Lottery, LotteryItem, Product } from "@/types/domain";

export type Tab = "managed" | "applied" | "won" | "all";
export type AllFilter = "any" | "unmanaged" | "skipped" | "history";
export type SortMode = "deadline" | "result";

/** ★管理対象タブのスルー表示: normal=自分がスルーしていないもの / include=すべて / only=自分がスルーしたもの */
export type SkipView = "normal" | "include" | "only";

/** ★管理対象タブの応募済み表示: exclude=現在のプロフィールが応募済みの抽選を隠す（既定）/ include=含める */
export type AppliedView = "exclude" | "include";

export interface Filters {
  query: string;
  chainId: string;
  /** 商品で絞り込み（複数商品の抽選も、いずれかの明細に含まれていれば対象） */
  productId: string;
  skip: SkipView;
  applied: AppliedView;
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
  applied: "exclude",
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
  return hasPendingResult(data, lottery.id) && isResultFinished(lottery, now) === true;
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
      // 継続抽選・招待制販売は「継続中の抽選」に分けて表示する（応募済みタブの件数・一覧には含めない）
      return hasPendingResult(data, lottery.id) && kindOf(lottery) === "normal";
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

/** 応募済みタブの並び: 発表期間中・結果未確認を最優先 → 発表日の近い順 → 発表日不明は末尾。 */
function appliedRank(_data: AppData, l: Lottery, now: Date): number {
  const stage = resultStage(l, now);
  if (stage === "overdue" || stage === "in_period") return 0;
  if (stage === "unknown") return 2;
  return 1;
}

/** 当選タブの並び: 現在のプロフィールの次の手続きを基準に、期限超過 → 期限の近い順 → 期限未確認 → 完了。 */
function wonProgressOf(data: AppData, l: Lottery, now: Date, profileId?: string) {
  const won = liveApplications(data, l.id).filter((a) => a.result === "won");
  const mine = profileId ? myApplication(data, l.id, profileId) : undefined;
  const app = mine?.result === "won" ? mine : won.find((a) => a.fulfillment !== "purchased") ?? won[0];
  return app ? wonProgress(l, app, now) : null;
}
function wonRank(data: AppData, l: Lottery, now: Date, profileId?: string): number {
  const p = wonProgressOf(data, l, now, profileId);
  return p ? wonSortRank(p) : 4;
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

/**
 * ★管理対象タブで、現在のプロフィールが応募済みの抽選を隠す。判定は現在のプロフィールだけ（他のプロフィールの応募は無関係）。
 * 応募は抽選単位（複数商品も1つの応募に含まれる）なので、応募済みなら未応募の商品は残らない。
 * keepIds は退場アニメーション中のカード（応募直後に一定時間だけ残す）。
 */
function matchAppliedView(data: AppData, lottery: Lottery, f: Filters, tab: Tab, now: Date, profileId?: string, keepIds?: ReadonlySet<string>): boolean {
  if (tab !== "managed" || !profileId || f.applied === "include") return true;
  if (keepIds?.has(lottery.id)) return true;
  return applyControlFor(data, lottery, profileId, now).kind !== "applied";
}

export function selectLotteries(data: AppData, tab: Tab, f: Filters, now: Date, profileId?: string, keepIds?: ReadonlySet<string>): Lottery[] {
  const list = data.lotteries.filter(
    (l) =>
      inTab(data, l, tab, now) &&
      matchFilters(data, l, f) &&
      matchSkipView(data, l, f, tab, profileId) &&
      matchAppliedView(data, l, f, tab, now, profileId, keepIds) &&
      (tab !== "all" || matchAllFilter(data, l, f.allFilter, now)),
  );

  const byDeadline = (a: Lottery, b: Lottery) => sortKey(a.applyDeadline) - sortKey(b.applyDeadline);
  const byResult = (a: Lottery, b: Lottery) => resultSortKey(a) - resultSortKey(b);
  const safe = (n: number) => (Number.isNaN(n) ? 0 : n);

  return [...list].sort((a, b) => {
    if (tab === "applied") {
      const r = appliedRank(data, a, now) - appliedRank(data, b, now);
      return r !== 0 ? r : safe(byResult(a, b));
    }
    if (tab === "won") {
      const r = wonRank(data, a, now, profileId) - wonRank(data, b, now, profileId);
      return r !== 0 ? r : safe(sortKey(wonProgressOf(data, a, now, profileId)?.deadline ?? a.procedureDeadline) - sortKey(wonProgressOf(data, b, now, profileId)?.deadline ?? b.procedureDeadline));
    }
    return safe(f.sort === "result" ? byResult(a, b) : byDeadline(a, b));
  });
}

/** 数量のみの表記（カード用）。BOXは入数が確認できる商品だけパック換算を添える。 */
export function formatQuantity(item: Pick<LotteryItem, "quantity" | "unit">, product: Product | undefined): string {
  if (item.unit === "set") return `${item.quantity}セット`;
  if (item.unit === "pack") return `${item.quantity}P`;
  const packs = product && !product.provisional && product.packsPerBox ? `(${item.quantity * product.packsPerBox}P)` : "";
  return `${item.quantity}BOX${packs}`;
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
