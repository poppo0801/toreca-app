import { describe, expect, it } from "vitest";
import {
  availableStates,
  balancesOf,
  DEFAULT_BOX_SETTINGS,
  filterBoxes,
  sortBoxes,
  summarizeBoxes,
  totalsOfBoxes,
  unitBuyback,
  latestPrices,
  type BoxLotRow,
  type BoxMovementRow,
  type BoxPriceRow,
} from "@/lib/box-collection";

const lot = (o: Partial<BoxLotRow> & { id: string; productId: string }): BoxLotRow => ({
  sourceKind: "manual",
  purchaseItemId: null,
  acquiredOn: "2026-11-01",
  chainId: null,
  storeId: null,
  storeLabel: "",
  actualUnitPrice: null,
  marketUnitPrice: null,
  marketPriceSource: "",
  marketPriceDate: null,
  note: "",
  archived: false,
  createdAt: "2026-11-01T00:00:00Z",
  ...o,
});
let n = 0;
const mv = (lotId: string, state: BoxMovementRow["state"], qty: number, kind: BoxMovementRow["kind"] = "adjust"): BoxMovementRow => ({
  id: `m${n++}`,
  lotId,
  kind,
  state,
  qty,
  opId: null,
  revertsOp: null,
  refId: null,
  note: "",
  occurredAt: "2026-11-01T00:00:00Z",
});
const price = (productId: string, amountYen: number, state: BoxPriceRow["state"] = null, confirmedOn = "2026-12-01", createdAt = "2026-12-01T00:00:00Z"): BoxPriceRow => ({ id: `p${n++}`, productId, state, amountYen, confirmedOn, source: "手動", createdAt });
const products = [
  { id: "A", name: "テラスタルフェスex", releaseDate: "2024-12-06" },
  { id: "B", name: "ステラミラクル", releaseDate: "2024-07-19" },
  { id: "C", name: "価格未取得BOX", releaseDate: null },
];

describe("BOXの購入時点の評価額", () => {
  it("購入時点の市場相場を優先し、無ければ実購入価格。買取は現在の参考相場（収支の支出とは別）", () => {
    const lots = [lot({ id: "l1", productId: "A", actualUnitPrice: 5400, marketUnitPrice: 12000 })];
    const bal = balancesOf([mv("l1", "shrink", 1)]);
    const rows = summarizeBoxes(products, lots, bal, [price("A", 10000)], DEFAULT_BOX_SETTINGS);
    expect(rows[0].purchaseTotal).toBe(12000);
    expect(rows[0].buybackTotal).toBe(10000);
    const fallback = summarizeBoxes(products, [lot({ id: "l2", productId: "A", actualUnitPrice: 5400 })], balancesOf([mv("l2", "shrink", 2)]), [], DEFAULT_BOX_SETTINGS);
    expect(fallback[0].purchaseTotal).toBe(10800); // 実購入価格にフォールバック
    expect(fallback[0].buybackTotal).toBeNull(); // 相場が無いものは未取得（0円にしない）
    expect(fallback[0].buybackMissingQty).toBe(2);
  });
  it("価格がどちらも不明なロットは「未取得」として数え、合計に0円として含めない", () => {
    const lots = [lot({ id: "l1", productId: "A", marketUnitPrice: 8000 }), lot({ id: "l2", productId: "A" })];
    const bal = balancesOf([mv("l1", "shrink", 1), mv("l2", "unknown", 2)]);
    const row = summarizeBoxes(products, lots, bal, [], DEFAULT_BOX_SETTINGS)[0];
    expect(row.qty).toBe(3);
    expect(row.purchaseTotal).toBe(8000);
    expect(row.purchaseMissingQty).toBe(2);
  });
  it("売却・開封で所有数が0になったロットと、削除（アーカイブ）済みのロットは集計に含めない", () => {
    const lots = [lot({ id: "l1", productId: "A", marketUnitPrice: 8000 }), lot({ id: "l2", productId: "B", marketUnitPrice: 9000, archived: true })];
    const bal = balancesOf([mv("l1", "shrink", 2), mv("l1", "shrink", -2, "sale"), mv("l2", "shrink", 1)]);
    expect(summarizeBoxes(products, lots, bal, [], DEFAULT_BOX_SETTINGS)).toHaveLength(0);
  });
});

describe("シュリンク状態別の買取評価", () => {
  const settings = DEFAULT_BOX_SETTINGS;
  it("状態別の実際の相場があればそれを優先し、無ければ基準相場に補正倍率（あり100%・なし85%）", () => {
    const latest = latestPrices([price("A", 10000), price("A", 7000, "no_shrink")]);
    expect(unitBuyback("A", "shrink", latest, settings)).toMatchObject({ amount: 10000, basis: "adjusted" });
    expect(unitBuyback("A", "no_shrink", latest, settings)).toMatchObject({ amount: 7000, basis: "actual" });
    const baseOnly = latestPrices([price("A", 10000)]);
    expect(unitBuyback("A", "no_shrink", baseOnly, settings)).toMatchObject({ amount: 8500, basis: "adjusted" });
  });
  it("状態未確認は基準相場のまま（未確認として数える）。補正倍率は設定で変えられる", () => {
    const latest = latestPrices([price("A", 10000)]);
    expect(unitBuyback("A", "unknown", latest, settings)).toMatchObject({ amount: 10000, basis: "base" });
    expect(unitBuyback("A", "no_shrink", latest, { shrinkPct: 100, noShrinkPct: 70 }).amount).toBe(7000);
    expect(unitBuyback("Z", "shrink", latest, settings)).toEqual({ amount: null, basis: "none", date: null });
  });
  it("テラスタルフェスex: シュリンクあり2BOX＋なし1BOXを状態別に評価する", () => {
    const lots = [lot({ id: "l1", productId: "A", marketUnitPrice: 12000 })];
    const bal = balancesOf([mv("l1", "shrink", 2), mv("l1", "no_shrink", 1)]);
    const row = summarizeBoxes(products, lots, bal, [price("A", 10000)], settings)[0];
    expect(row.byState).toEqual({ shrink: 2, no_shrink: 1, unknown: 0 });
    expect(row.buybackTotal).toBe(2 * 10000 + 8500);
    expect(row.purchaseTotal).toBe(36000);
    expect(availableStates(row.byState)).toEqual(["shrink", "no_shrink"]);
  });
  it("最新の相場を現在の値にし、確認日が同じなら登録が新しい方", () => {
    const latest = latestPrices([price("A", 9000, null, "2026-11-01"), price("A", 10000, null, "2026-12-01"), price("A", 10500, null, "2026-12-01", "2026-12-01T05:00:00Z")]);
    expect(unitBuyback("A", "shrink", latest, DEFAULT_BOX_SETTINGS).amount).toBe(10500);
  });
});

describe("合計・並び順・絞り込み", () => {
  const lots = [lot({ id: "l1", productId: "A", marketUnitPrice: 12000 }), lot({ id: "l2", productId: "B", marketUnitPrice: 6000 }), lot({ id: "l3", productId: "C" })];
  const bal = balancesOf([mv("l1", "shrink", 1), mv("l2", "unknown", 2), mv("l3", "shrink", 1)]);
  const prices = [price("A", 10000, null, "2026-12-01"), price("B", 5000, null, "2026-11-20")];
  const rows = summarizeBoxes(products, lots, bal, prices, DEFAULT_BOX_SETTINGS);
  it("合計は購入・買取・BOX数。最終取得日は最も新しい日。未取得は別に数える", () => {
    const t = totalsOfBoxes(rows);
    expect(t).toMatchObject({ kinds: 3, qty: 4, purchaseTotal: 24000, purchaseMissingQty: 1, buybackTotal: 20000, buybackMissingQty: 1, buybackUnconfirmedQty: 2, priceDate: "2026-12-01" });
  });
  it("価格の高い順（初期）・安い順。価格未取得の商品も表示し、末尾に置く", () => {
    expect(sortBoxes(rows, "priceDesc").map((r) => r.productId)).toEqual(["A", "B", "C"]);
    expect(sortBoxes(rows, "priceAsc").map((r) => r.productId)).toEqual(["B", "A", "C"]);
  });
  it("発売日の新しい順・古い順。発売日が不明な商品は末尾", () => {
    expect(sortBoxes(rows, "releaseDesc").map((r) => r.productId)).toEqual(["A", "B", "C"]);
    expect(sortBoxes(rows, "releaseAsc").map((r) => r.productId)).toEqual(["B", "A", "C"]);
  });
  it("同じ価格でも順序が揺れない（発売日→名前→ID）。入力順を変えても同じ並び", () => {
    const same = [
      { ...rows[0], productId: "X2", name: "同額B", refUnit: 5000, releaseDate: "2024-01-01" },
      { ...rows[0], productId: "X1", name: "同額A", refUnit: 5000, releaseDate: "2024-01-01" },
      { ...rows[0], productId: "X3", name: "同額C", refUnit: 5000, releaseDate: "2025-01-01" },
    ];
    const a = sortBoxes(same, "priceDesc").map((r) => r.productId);
    const b = sortBoxes([...same].reverse(), "priceDesc").map((r) => r.productId);
    expect(a).toEqual(["X3", "X1", "X2"]);
    expect(b).toEqual(a);
  });
  it("商品名と状態で絞り込める", () => {
    expect(filterBoxes(rows, { q: "フェス", state: "all" }).map((r) => r.productId)).toEqual(["A"]);
    expect(filterBoxes(rows, { q: "", state: "unknown" }).map((r) => r.productId)).toEqual(["B"]);
  });
});
