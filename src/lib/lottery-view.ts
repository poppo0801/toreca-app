import { isResultFinished, jstDateString, resultSortKey, sortKey } from "@/lib/datetime";
import { effectiveEventState, isSkippedBy, profileSeesLottery } from "@/lib/eligibility";
import { matchRegion } from "@/lib/region-filter";
import { kindOf, myApplication, resultStage, wonProgress, wonSortRank } from "@/lib/lottery-flow";
import type { AppData, Application, Lottery, LotteryItem, Product } from "@/types/domain";

export type Tab = "managed" | "applied" | "won" | "all";
export type AllFilter = "any" | "unmanaged" | "skipped";
export type SortMode = "deadline" | "result";

/** スルー表示（全タブ共通）: normal=自分がスルーしていないもの / include=すべて / only=自分がスルーしたもの */
export type SkipView = "normal" | "include" | "only";

/**
 * 状態の絞り込み（現在選択中のプロフィール基準）。
 *  default=受付中かつ未応募（全情報・★管理対象の既定）/ open=受付中 / closed=受付終了 / unapplied=未応募 / applied=応募済み / won=当選 / lost=落選 / any=すべて。
 * 応募・当落は現在のプロフィールのものだけで判定する（他のプロフィールが応募済みでも、現在のプロフィールが未応募なら未応募）。
 */
export type StatusFilter = "default" | "open" | "closed" | "unapplied" | "applied" | "won" | "lost" | "any";

export interface Filters {
  query: string;
  chainId: string;
  /** 商品で絞り込み（複数商品の抽選も、いずれかの明細に含まれていれば対象） */
  productId: string;
  skip: SkipView;
  status: StatusFilter;
  /** 地域（都道府県の複数選択。空 = 地域で絞らない）。通販・発送のみ・所在地不明は除外しない（region-filter.ts） */
  prefectures: string[];
  receiveMethod: string;
  /** 店舗で絞り込み */
  storeId: string;
  /** 応募方法（web / store / app / unknown）で絞り込み */
  applyMethod: string;
  allFilter: AllFilter;
  sort: SortMode;
}

export const DEFAULT_FILTERS: Filters = {
  query: "",
  chainId: "",
  productId: "",
  skip: "normal",
  status: "default",
  prefectures: [],
  receiveMethod: "",
  storeId: "",
  applyMethod: "",
  allFilter: "any",
  sort: "deadline",
};

/** タブごとの既定の絞り込み。全情報・★管理対象は「受付中かつ未応募」、応募済み・当選タブは状態で絞らない */
export function defaultFiltersFor(tab: Tab): Filters {
  return tab === "all" || tab === "managed" ? DEFAULT_FILTERS : { ...DEFAULT_FILTERS, status: "any" };
}

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

/**
 * 受付の状態。継続抽選・招待制販売は有効期限（validUntil）を過ぎたら受付終了として扱う（期限が未設定なら、締切の扱いに従う）。
 */
export function eventStateOf(lottery: Lottery, now: Date): Lottery["eventState"] {
  const event = effectiveEventState(lottery, now);
  if ((event === "open" || event === "before") && kindOf(lottery) !== "normal" && lottery.validUntil && lottery.validUntil < jstDateString(now)) return "closed";
  return event;
}

/** 画面のタブは保存場所ではなく検索ビュー（database-schema.md §2）。受付の終了・応募済みの除外は「状態」の絞り込みで行う。 */
export function inTab(data: AppData, lottery: Lottery, tab: Tab, _now: Date): boolean {
  void _now;
  switch (tab) {
    case "managed":
      // ★が付いている抽選だけ（★なしは表示しない）
      return isManaged(data, lottery.id);
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
  if (!matchRegion(f.prefectures, store?.prefecture, lottery.receiveMethod === "shipping" || (store?.salesKind ?? "physical") !== "physical")) return false;
  if (f.receiveMethod && lottery.receiveMethod !== f.receiveMethod) return false;
  if (f.storeId && lottery.storeId !== f.storeId) return false;
  if (f.applyMethod && lottery.applyMethod !== f.applyMethod) return false;
  if (f.productId && !lottery.items.some((i) => i.productId === f.productId)) return false;
  return matchesQuery(data, lottery, f.query);
}

/** 検索語の正規化（全角半角・大小文字・空白の揺れを吸収。マスターの別名照合と同じ規則） */
const normQuery = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/**
 * 横断検索: 商品名・商品の略称/別名/コード・系列名と別名・店舗名と別名・都道府県・メモのいずれかに一致すれば対象。
 * 空白（全角含む）区切りの複数語は、すべての語がどこかに一致すること（AND）。
 * 検索は表示済みの抽選（プロフィールの閲覧範囲で絞られた一覧）の中の絞り込みで、閲覧制限を回避しない。
 */
export function matchesQuery(data: AppData, lottery: Lottery, query: string): boolean {
  const tokens = query.normalize("NFKC").trim().split(/\s+/).map(normQuery).filter(Boolean);
  if (tokens.length === 0) return true;
  const chain = data.chains.find((c) => c.id === lottery.chainId);
  const store = data.stores.find((s) => s.id === lottery.storeId);
  const hay = [
    chain?.name,
    ...(chain?.aliases ?? []),
    store?.name,
    ...(store?.aliases ?? []),
    store?.prefecture,
    lottery.memo,
    ...lottery.items.flatMap((i) => {
      const p = data.products.find((x) => x.id === i.productId);
      return p ? [p.officialName, p.code, ...p.aliases] : [];
    }),
  ]
    .filter((x): x is string => !!x)
    .map(normQuery);
  return tokens.every((t) => hay.some((h) => h.includes(t)));
}

function matchAllFilter(data: AppData, lottery: Lottery, f: AllFilter): boolean {
  switch (f) {
    case "any":
      return true;
    case "unmanaged":
      return !isManaged(data, lottery.id);
    case "skipped":
      return isSkippedByAnyone(data, lottery.id);
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
 * スルーはプロフィール別。全タブ（全情報・★管理対象・応募済み・当選）で、既定で「自分がスルーした抽選」を一覧から外す（他のプロフィールには影響しない）。
 * 応募・当選・購入・受取の記録は消さず、絞り込みで「含む／のみ」にすれば表示できる。全情報タブの「スルーのみ」はその絞り込み自体が表示対象を決めるため、ここでは外さない。
 * profileId を渡さない場合（集計用途など）はスルーで絞らない。
 */
function matchSkipView(data: AppData, lottery: Lottery, f: Filters, tab: Tab, profileId?: string): boolean {
  if (!profileId || f.skip === "include") return true;
  if (tab === "all" && f.allFilter === "skipped") return true;
  const skipped = isSkippedBy(data, profileId, lottery);
  return f.skip === "only" ? skipped : !skipped;
}

/**
 * 状態の絞り込み。判定は現在のプロフィールだけ（他のプロフィールの応募は無関係）。
 * 応募は抽選単位（複数商品も1つの応募に含まれる）なので、応募済みなら未応募の商品は残らない。
 * keepIds は退場アニメーション中のカード（応募直後に一定時間だけ残す）。
 */
export function matchStatus(data: AppData, lottery: Lottery, status: StatusFilter, now: Date, profileId?: string, keepIds?: ReadonlySet<string>): boolean {
  if (status === "any") return true;
  if (keepIds?.has(lottery.id)) return true;
  const event = eventStateOf(lottery, now);
  const open = event === "open" || event === "before";
  const mine = profileId ? myApplication(data, lottery.id, profileId) : undefined;
  switch (status) {
    case "default":
      return open && !mine;
    case "open":
      return open;
    case "closed":
      return event === "closed" || event === "cancelled";
    case "unapplied":
      return !mine;
    case "applied":
      return !!mine;
    case "won":
      return mine?.result === "won";
    case "lost":
      return mine?.result === "lost";
  }
}

export function selectLotteries(data: AppData, tab: Tab, f: Filters, now: Date, profileId?: string, keepIds?: ReadonlySet<string>): Lottery[] {
  // 「受付中・未応募」の既定は全情報・★管理対象のもの。応募済み・当選タブでは、状態を指定していなければ絞らない
  const status: StatusFilter = f.status === "default" && (tab === "applied" || tab === "won") ? "any" : f.status;
  const list = data.lotteries.filter(
    (l) =>
      inTab(data, l, tab, now) &&
      matchFilters(data, l, f) &&
      matchSkipView(data, l, f, tab, profileId) &&
      matchStatus(data, l, status, now, profileId, keepIds) &&
      (!profileId || profileSeesLottery(data, profileId, l)) &&
      (tab !== "all" || matchAllFilter(data, l, f.allFilter)),
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
