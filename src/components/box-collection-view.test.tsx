import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOX_SETTINGS, type BoxLotRow, type BoxMovementRow, type BoxPriceRow } from "@/lib/box-collection";
import type { BoxCollectionData } from "@/lib/server/box-collection-service";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saveSettings = vi.fn();
let loaded: BoxCollectionData;
vi.mock("@/app/(app)/collection/box-actions", () => ({
  loadBoxCollectionAction: async () => ({ ok: true, data: loaded }),
  addManualBoxAction: vi.fn(),
  addBoxPricesAction: vi.fn(),
  adjustBoxAction: vi.fn(),
  importPurchaseItemAction: vi.fn(),
  openBoxesAction: vi.fn(),
  revertBoxOpAction: vi.fn(),
  saveBoxSettingsAction: vi.fn(),
  updateBoxLotAction: vi.fn(),
}));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({
    profile: { id: "p1" },
    settings: { collection: { view: "grid", cols: 4, fx: false } },
    saveSettings,
    data: { products: [] },
  }),
}));

import { BoxCollectionPanel } from "@/components/box-collection-view";

let root: Root;
let host: HTMLDivElement;

const lot = (id: string, productId: string, o: Partial<BoxLotRow> = {}): BoxLotRow => ({
  id,
  productId,
  sourceKind: "manual",
  purchaseItemId: null,
  acquiredOn: "2026-11-01",
  chainId: null,
  storeId: null,
  storeLabel: "テスト店",
  actualUnitPrice: null,
  marketUnitPrice: null,
  marketPriceSource: "",
  marketPriceDate: null,
  note: "",
  archived: false,
  createdAt: "2026-11-01T00:00:00Z",
  ...o,
});
const mv = (lotId: string, state: BoxMovementRow["state"], qty: number): BoxMovementRow => ({ id: `${lotId}${state}`, lotId, kind: "adjust", state, qty, opId: null, revertsOp: null, refId: null, note: "", occurredAt: "2026-11-01T00:00:00Z" });
const price = (productId: string, amountYen: number, confirmedOn = "2026-12-01"): BoxPriceRow => ({ id: `pr${productId}`, productId, state: null, amountYen, confirmedOn, source: "手動", createdAt: "2026-12-01T00:00:00Z" });

function setData(d: Partial<BoxCollectionData>) {
  loaded = {
    products: [
      { id: "A", name: "テラスタルフェスex", releaseDate: "2024-12-06" },
      { id: "B", name: "ステラミラクル", releaseDate: "2024-07-19" },
      { id: "C", name: "価格未取得BOX", releaseDate: "2025-01-01" },
    ],
    lots: [],
    movements: [],
    prices: [],
    market: [],
    status: [],
    settings: DEFAULT_BOX_SETTINGS,
    importable: [],
    ...d,
  };
}
async function mount() {
  root = createRoot(host);
  await act(async () => root.render(createElement(BoxCollectionPanel)));
  await act(async () => void (await Promise.resolve()));
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const names = () => [...host.querySelectorAll('[data-testid="box-tile"]')].map((t) => t.textContent ?? "");

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  saveSettings.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("BOXコレクションの表示", () => {
  it("購入は購入時点の市場相場、買取は現在の参考買取相場、BOX数。実購入価格（支出）とは別の数字", async () => {
    setData({ lots: [lot("l1", "A", { actualUnitPrice: 5400, marketUnitPrice: 12000 })], movements: [mv("l1", "shrink", 1)], prices: [price("A", 10000)] });
    await mount();
    expect(q("box-summary-line")!.textContent).toContain("購入 12,000円");
    expect(q("box-summary-line")!.textContent).toContain("買取 10,000円");
    expect(q("box-summary-line")!.textContent).toContain("1BOX");
    expect(q("box-summary-line")!.textContent).not.toContain("5,400"); // 実際の支払額は収支で確認する
    expect(q("box-price-date")!.textContent).toBe("12/1"); // 最終価格取得日
    expect(host.textContent).not.toContain("一部"); // 全て取得済みなら出さない
  });
  it("価格が一部しか無いときは「一部」を出し、未取得を取得済みのように見せない", async () => {
    setData({ lots: [lot("l1", "A", { marketUnitPrice: 12000 }), lot("l2", "B")], movements: [mv("l1", "shrink", 1), mv("l2", "unknown", 1)], prices: [price("A", 10000)] });
    await mount();
    expect(host.textContent).toContain("一部");
    expect(q("box-summary-line")!.textContent).toContain("購入 12,000円");
    await act(async () => q("box-summary-line")!.click());
    expect(q("box-stats-partial")!.textContent).toContain("購入時点の価格が未取得 1BOX");
    expect(q("box-stats-partial")!.textContent).toContain("買取相場が未取得 1BOX");
  });
  it("相場が1つも無いときは「—」（0円としない）", async () => {
    setData({ lots: [lot("l1", "A")], movements: [mv("l1", "unknown", 2)] });
    await mount();
    expect(q("box-summary-line")!.textContent).toContain("購入 —");
    expect(q("box-summary-line")!.textContent).toContain("買取 —");
    expect(q("box-summary-line")!.textContent).toContain("2BOX");
    expect(q("box-price-date")).toBeNull();
  });
  it("初期は価格の高い順。価格未取得の商品も表示し末尾に並ぶ。並び順の切替ができる", async () => {
    setData({
      lots: [lot("l1", "A", { marketUnitPrice: 12000 }), lot("l2", "B", { marketUnitPrice: 6000 }), lot("l3", "C")],
      movements: [mv("l1", "shrink", 1), mv("l2", "shrink", 1), mv("l3", "shrink", 1)],
      prices: [price("A", 10000), price("B", 5000)],
    });
    await mount();
    expect((q("box-sort") as HTMLSelectElement).value).toBe("priceDesc");
    expect(names().map((n) => n.replace(/[×\d]/g, "").slice(0, 3))).toEqual(["テラス", "ステラ", "価格未"]);
    const sel = q("box-sort") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "priceAsc");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(names().map((n) => n.replace(/[×\d]/g, "").slice(0, 3))).toEqual(["ステラ", "テラス", "価格未"]);
    expect([...sel.options].map((o) => o.textContent)).toEqual(["価格の高い順", "価格の安い順", "発売日の新しい順", "発売日の古い順"]);
  });
  it("所有数が0のBOX（売却・開封済み）は一覧に出ない。空のときは案内を出す", async () => {
    setData({ lots: [lot("l1", "A", { marketUnitPrice: 1 })], movements: [mv("l1", "shrink", 2), mv("l1", "shrink", -2)] });
    await mount();
    expect(names()).toHaveLength(0);
    expect(q("box-empty")!.textContent).toContain("まだBOXが登録されていません");
  });
  it("状態未確認のBOXには「未確認」の印が付く。タイルを開くと状態別の数量・評価を確認できる", async () => {
    setData({ lots: [lot("l1", "A", { marketUnitPrice: 12000 })], movements: [mv("l1", "shrink", 2), mv("l1", "no_shrink", 1), mv("l1", "unknown", 1)], prices: [price("A", 10000)] });
    await mount();
    expect(q("box-tile-unknown")).not.toBeNull();
    await act(async () => (host.querySelector('[data-testid="box-tile"] button') as HTMLElement).click());
    const states = document.querySelector('[data-testid="box-states"]')!;
    expect(states.textContent).toContain("シュリンクあり");
    expect(states.textContent).toContain("2BOX");
    expect(states.textContent).toContain("8,500円"); // シュリンクなしは基準×85%
    expect(document.querySelector('[data-testid="state-unknown"]')!.textContent).toContain("基準相場（シュリンク状態を考慮しない）");
  });
});
