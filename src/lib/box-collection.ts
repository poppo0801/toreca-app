import type { ShrinkState } from "@/types/domain";
import { jstDate } from "@/lib/collection";

/**
 * BOXコレクションの集計・評価・並び替え（純関数）。DBには在庫の履歴・購入ロット・相場が入っており、ここでは表示用に計算する。
 *  - 購入（評価額）: 購入時点の市場相場があればそれ、なければ実購入価格。どちらも無いロットは「未取得」（0円とはみなさない）
 *  - 買取: 現在の参考買取相場。状態別の実際の相場があればそれを優先し、なければ基準相場×補正倍率（シュリンクあり100%・なし85%が初期値）。
 *    状態「－」は基準相場そのままで、未確認であることを示す。相場が無い商品は「未取得」で、取得済みとして表示しない
 *  - 参考評価であり、買取の保証額ではない
 *  - 価格の優先順位（Stage 7F）: ①手動の相場（状態別 → 基準×倍率）→ ②取得した相場の状態別の実価格（CSVにシュリンクの有無が明示されたもの）→ ③取得した基準相場×倍率 → ④未取得。
 *    取得した相場で手動の相場を上書きしない。基準にできる根拠（「未開封」「新品」）が無い価格は評価に使わない
 */

export const BOX_STATES: ShrinkState[] = ["shrink", "no_shrink", "unknown"];
export const BOX_STATE_LABEL: Record<ShrinkState, string> = { shrink: "シュリンクあり", no_shrink: "シュリンクなし", unknown: "－" };

export interface BoxLotRow {
  id: string;
  productId: string;
  sourceKind: "purchase" | "manual";
  purchaseItemId: string | null;
  acquiredOn: string | null;
  chainId: string | null;
  storeId: string | null;
  storeLabel: string;
  /** 1BOXあたりの実際の購入価格（不明は null） */
  actualUnitPrice: number | null;
  /** 購入時点の市場相場（1BOXあたり。不明は null）。履歴として固定する */
  marketUnitPrice: number | null;
  marketPriceSource: string;
  marketPriceDate: string | null;
  note: string;
  archived: boolean;
  createdAt: string;
}

export interface BoxMovementRow {
  id: string;
  lotId: string;
  kind: "purchase" | "receive" | "sale" | "open" | "adjust";
  state: ShrinkState;
  qty: number;
  opId: string | null;
  revertsOp: string | null;
  refId: string | null;
  note: string;
  occurredAt: string;
}

export interface BoxPriceRow {
  id: string;
  productId: string;
  /** null=基準相場（状態指定なし） */
  state: ShrinkState | null;
  amountYen: number;
  confirmedOn: string;
  source: string;
  createdAt: string;
}

/** 取得したBOXの相場（CSV。手動の box_prices とは別。Stage 7F） */
export interface BoxMarketRow {
  productId: string;
  kind: "sale" | "buyback";
  /** base=状態の指定なし（未開封・新品）/ shrink・no_shrink=CSVにシュリンクの有無が明示されたもの */
  basis: "base" | "shrink" | "no_shrink";
  medianYen: number;
  lowYen: number;
  highYen: number;
  sampleCount: number;
  outlierCount: number;
  shops: { shop: string; price: number; condition: string; url: string; scrapedAt: string }[];
  source: string;
  sourceUrl: string | null;
  csvUpdatedAt: string | null;
  fetchedAt: string;
  matchMethod: "code" | "name" | "alias" | "manual";
}

export interface BoxSettings {
  shrinkPct: number;
  noShrinkPct: number;
}
export const DEFAULT_BOX_SETTINGS: BoxSettings = { shrinkPct: 100, noShrinkPct: 85 };

export type StateCounts = Record<ShrinkState, number>;
export const emptyCounts = (): StateCounts => ({ shrink: 0, no_shrink: 0, unknown: 0 });

/** ロットごと・状態ごとの現在の所有数（履歴の合計） */
export function balancesOf(movements: BoxMovementRow[]): Map<string, StateCounts> {
  const m = new Map<string, StateCounts>();
  for (const mv of movements) {
    const c = m.get(mv.lotId) ?? emptyCounts();
    c[mv.state] += mv.qty;
    m.set(mv.lotId, c);
  }
  return m;
}

const priceKey = (productId: string, state: ShrinkState | null) => `${productId}|${state ?? ""}`;

/** 商品・状態ごとの最新の相場（確認日が新しいもの。同日なら登録が新しいもの） */
export function latestPrices(prices: BoxPriceRow[]): Map<string, BoxPriceRow> {
  const m = new Map<string, BoxPriceRow>();
  for (const p of prices) {
    const k = priceKey(p.productId, p.state);
    const cur = m.get(k);
    if (!cur || p.confirmedOn > cur.confirmedOn || (p.confirmedOn === cur.confirmedOn && p.createdAt > cur.createdAt)) m.set(k, p);
  }
  return m;
}

export interface UnitBuyback {
  amount: number | null;
  /** actual=状態別の実際の相場 / adjusted=基準相場×補正倍率 / base=基準相場そのまま（状態未確認） / none=相場なし */
  basis: "actual" | "adjusted" | "base" | "none";
  date: string | null;
  /** 価格の出所。manual=手動 / market=取得した相場 / null=相場なし */
  source: "manual" | "market" | null;
  /** 取得した相場のとき、価格に使った店舗数 */
  samples: number | null;
}

export const jstDateOf = jstDate;
export const marketKey = (productId: string, kind: BoxMarketRow["kind"], basis: BoxMarketRow["basis"]) => `${productId}|${kind}|${basis}`;
export function indexMarket(rows: BoxMarketRow[]): Map<string, BoxMarketRow> {
  return new Map(rows.map((r) => [marketKey(r.productId, r.kind, r.basis), r]));
}

const pctOf = (state: ShrinkState, s: BoxSettings) => (state === "shrink" ? s.shrinkPct : state === "no_shrink" ? s.noShrinkPct : 100);

/** 1BOXあたりの参考買取相場（状態別）。補正は円未満を四捨五入 */
export function unitBuyback(productId: string, state: ShrinkState, latest: Map<string, BoxPriceRow>, settings: BoxSettings, market: Map<string, BoxMarketRow> = new Map()): UnitBuyback {
  const man = (amount: number, basis: UnitBuyback["basis"], date: string): UnitBuyback => ({ amount, basis, date, source: "manual", samples: null });
  if (state !== "unknown") {
    const own = latest.get(priceKey(productId, state));
    if (own) return man(own.amountYen, "actual", own.confirmedOn);
  }
  const base = latest.get(priceKey(productId, null));
  if (base) return state === "unknown" ? man(base.amountYen, "base", base.confirmedOn) : man(Math.round((base.amountYen * pctOf(state, settings)) / 100), "adjusted", base.confirmedOn);
  // 手動の相場が無いときだけ、取得した相場を使う（状態の実価格 → 基準×倍率）
  const mk = (m: BoxMarketRow, amount: number, basis: UnitBuyback["basis"]): UnitBuyback => ({ amount, basis, date: jstDate(m.fetchedAt), source: "market", samples: m.sampleCount });
  if (state !== "unknown") {
    const own = market.get(marketKey(productId, "buyback", state));
    if (own) return mk(own, own.medianYen, "actual");
  }
  const mb = market.get(marketKey(productId, "buyback", "base"));
  if (!mb) return { amount: null, basis: "none", date: null, source: null, samples: null };
  return state === "unknown" ? mk(mb, mb.medianYen, "base") : mk(mb, Math.round((mb.medianYen * pctOf(state, settings)) / 100), "adjusted");
}

/** ロット1BOXあたりの購入時点の評価額。市場相場 → 実購入価格 → 未取得 */
export function lotUnitValue(lot: Pick<BoxLotRow, "marketUnitPrice" | "actualUnitPrice">): { amount: number | null; basis: "market" | "actual" | "none" } {
  if (lot.marketUnitPrice !== null) return { amount: lot.marketUnitPrice, basis: "market" };
  if (lot.actualUnitPrice !== null) return { amount: lot.actualUnitPrice, basis: "actual" };
  return { amount: null, basis: "none" };
}

export interface BoxSummaryRow {
  productId: string;
  name: string;
  releaseDate: string | null;
  qty: number;
  byState: StateCounts;
  /** 購入時点の評価額の合計（評価額が分かるBOXのみ）。1つも分からなければ null */
  purchaseTotal: number | null;
  purchaseMissingQty: number;
  /** 現在の参考買取の合計（相場があるBOXのみ）。1つも無ければ null */
  buybackTotal: number | null;
  buybackMissingQty: number;
  /** 状態未確認のBOXの買取は基準相場そのままで計算している（未確認を明示する） */
  buybackUnconfirmedQty: number;
  /** 並び替え用の1BOXあたりの価格。基準の買取相場 → 状態別の買取相場 → 購入時点の評価額（平均）→ 未取得(null) */
  refUnit: number | null;
  /** この商品の買取相場の最終取得日 */
  priceDate: string | null;
  /** 買取の評価に取得した相場を使ったBOX数と、そのうち最も少ない店舗数（1なら「1店舗のみ」と示す） */
  marketQty: number;
  marketMinSamples: number | null;
  lots: { lot: BoxLotRow; counts: StateCounts }[];
}

export interface BoxProductInfo {
  id: string;
  name: string;
  releaseDate: string | null;
}

export function summarizeBoxes(products: BoxProductInfo[], lots: BoxLotRow[], balances: Map<string, StateCounts>, prices: BoxPriceRow[], settings: BoxSettings, marketRows: BoxMarketRow[] = []): BoxSummaryRow[] {
  const latest = latestPrices(prices);
  const market = indexMarket(marketRows);
  const info = new Map(products.map((p) => [p.id, p]));
  const byProduct = new Map<string, BoxSummaryRow>();
  for (const lot of lots) {
    if (lot.archived) continue;
    const counts = balances.get(lot.id) ?? emptyCounts();
    const qty = counts.shrink + counts.no_shrink + counts.unknown;
    if (qty <= 0) continue;
    const p = info.get(lot.productId);
    const row =
      byProduct.get(lot.productId) ??
      ({ productId: lot.productId, name: p?.name ?? "商品未登録", releaseDate: p?.releaseDate ?? null, qty: 0, byState: emptyCounts(), purchaseTotal: null, purchaseMissingQty: 0, buybackTotal: null, buybackMissingQty: 0, buybackUnconfirmedQty: 0, refUnit: null, priceDate: null, marketQty: 0, marketMinSamples: null, lots: [] } satisfies BoxSummaryRow);
    row.qty += qty;
    const v = lotUnitValue(lot);
    if (v.amount === null) row.purchaseMissingQty += qty;
    else row.purchaseTotal = (row.purchaseTotal ?? 0) + v.amount * qty;
    for (const s of BOX_STATES) {
      const n = counts[s];
      if (n <= 0) continue;
      row.byState[s] += n;
      const b = unitBuyback(lot.productId, s, latest, settings, market);
      if (b.amount === null) row.buybackMissingQty += n;
      else row.buybackTotal = (row.buybackTotal ?? 0) + b.amount * n;
      if (b.source === "market" && b.samples !== null) {
        row.marketQty += n;
        row.marketMinSamples = row.marketMinSamples === null ? b.samples : Math.min(row.marketMinSamples, b.samples);
      }
      if (s === "unknown") row.buybackUnconfirmedQty += n;
    }
    row.lots.push({ lot, counts });
    byProduct.set(lot.productId, row);
  }
  for (const row of byProduct.values()) {
    const base = latest.get(priceKey(row.productId, null));
    const states = BOX_STATES.map((s) => latest.get(priceKey(row.productId, s))).filter((x): x is BoxPriceRow => !!x);
    const mBase = market.get(marketKey(row.productId, "buyback", "base"));
    const mStates = (["shrink", "no_shrink"] as const).map((b) => market.get(marketKey(row.productId, "buyback", b))).filter((x): x is BoxMarketRow => !!x);
    row.refUnit = base ? base.amountYen : (states[0]?.amountYen ?? mBase?.medianYen ?? mStates[0]?.medianYen ?? null);
    if (row.refUnit === null && row.purchaseTotal !== null) {
      const known = row.qty - row.purchaseMissingQty;
      row.refUnit = known > 0 ? Math.round(row.purchaseTotal / known) : null;
    }
    const manualDates = [base, ...states].filter((x): x is BoxPriceRow => !!x).map((x) => x.confirmedOn);
    const dates = [...manualDates, ...(manualDates.length === 0 ? [mBase, ...mStates].filter((x): x is BoxMarketRow => !!x).map((x) => jstDate(x.fetchedAt)) : [])];
    row.priceDate = dates.length > 0 ? dates.sort().at(-1)! : null;
    row.lots.sort((a, b) => (a.lot.acquiredOn ?? "9999").localeCompare(b.lot.acquiredOn ?? "9999") || a.lot.createdAt.localeCompare(b.lot.createdAt));
  }
  return [...byProduct.values()];
}

export interface BoxTotals {
  kinds: number;
  qty: number;
  purchaseTotal: number;
  purchaseMissingQty: number;
  buybackTotal: number;
  buybackMissingQty: number;
  buybackUnconfirmedQty: number;
  /** 買取相場の最終取得日（全商品のうち最も新しい日） */
  priceDate: string | null;
  /** 買取の評価に取得した相場を使ったBOX数 */
  marketQty: number;
}

export function totalsOfBoxes(rows: BoxSummaryRow[]): BoxTotals {
  const t: BoxTotals = { kinds: rows.length, qty: 0, purchaseTotal: 0, purchaseMissingQty: 0, buybackTotal: 0, buybackMissingQty: 0, buybackUnconfirmedQty: 0, priceDate: null, marketQty: 0 };
  for (const r of rows) {
    t.qty += r.qty;
    t.purchaseTotal += r.purchaseTotal ?? 0;
    t.purchaseMissingQty += r.purchaseMissingQty;
    t.buybackTotal += r.buybackTotal ?? 0;
    t.buybackMissingQty += r.buybackMissingQty;
    t.buybackUnconfirmedQty += r.buybackUnconfirmedQty;
    t.marketQty += r.marketQty;
    if (r.priceDate && (!t.priceDate || r.priceDate > t.priceDate)) t.priceDate = r.priceDate;
  }
  return t;
}

export type BoxSortKey = "priceDesc" | "priceAsc" | "releaseDesc" | "releaseAsc";
export const BOX_SORTS: { value: BoxSortKey; label: string }[] = [
  { value: "priceDesc", label: "価格の高い順" },
  { value: "priceAsc", label: "価格の安い順" },
  { value: "releaseDesc", label: "発売日の新しい順" },
  { value: "releaseAsc", label: "発売日の古い順" },
];

/**
 * 並び替え。価格・発売日が未取得の商品は、どちらの向きでも末尾に並べる。同じ値は 発売日(新しい順) → 名前 → ID で決め、順序が揺れない。
 */
export function sortBoxes(rows: BoxSummaryRow[], key: BoxSortKey): BoxSummaryRow[] {
  const tie = (a: BoxSummaryRow, b: BoxSummaryRow) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.name.localeCompare(b.name, "ja") || a.productId.localeCompare(b.productId);
  const num = (a: number | null, b: number | null, dir: 1 | -1) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * dir;
  };
  const date = (a: string | null, b: string | null, dir: 1 | -1) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b) * dir;
  };
  return [...rows].sort((a, b) => {
    const r = key === "priceDesc" ? num(a.refUnit, b.refUnit, -1) : key === "priceAsc" ? num(a.refUnit, b.refUnit, 1) : key === "releaseDesc" ? date(a.releaseDate, b.releaseDate, -1) : date(a.releaseDate, b.releaseDate, 1);
    return r || tie(a, b);
  });
}

export interface BoxFilters {
  q: string;
  /** 指定した状態のBOXを持つ商品だけ */
  state: "all" | ShrinkState;
}
export const DEFAULT_BOX_FILTERS: BoxFilters = { q: "", state: "all" };

export function filterBoxes(rows: BoxSummaryRow[], f: BoxFilters): BoxSummaryRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => (q === "" || r.name.toLowerCase().includes(q)) && (f.state === "all" || r.byState[f.state] > 0));
}

/** 売却・開封で選べる状態（所有数が1以上のもの） */
export function availableStates(counts: StateCounts): ShrinkState[] {
  return BOX_STATES.filter((s) => counts[s] > 0);
}
