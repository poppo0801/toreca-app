import { describe, expect, it } from "vitest";
import { orderOf, sortCards, type CardSummaryRow, type OrderRow } from "@/lib/collection";
import { percentLabel } from "@/components/expense-bar";
import { ALL_PERIOD, ledgerEntries, monthSummary, productFullName, purchaseTitle } from "@/lib/finance";
import { categoryOf, EXPENSE_CATEGORIES } from "@/lib/expense-category";
import type { AppData } from "@/types/domain";

const row = (id: string, createdAt: string, extra: Partial<CardSummaryRow> = {}) =>
  ({ id, name: id, createdAt, favRank: null, qty: 1, ...extra }) as unknown as CardSummaryRow;

describe("Stage 6R: プロフィール別の「標準」並び順", () => {
  const rows = [row("a", "2026-01-01"), row("b", "2026-01-02"), row("c", "2026-01-03"), row("d", "2026-01-04")];
  const orders: OrderRow[] = [
    { profileId: "A", cardId: "c", position: 0 },
    { profileId: "A", cardId: "a", position: 1 },
    { profileId: "B", cardId: "b", position: 0 },
    { profileId: "B", cardId: "a", position: 1 },
  ];
  it("保存順をプロフィールごとに取り出す（位置の昇順）", () => {
    expect(orderOf(orders, "A")).toEqual(["c", "a"]);
    expect(orderOf(orders, "B")).toEqual(["b", "a"]);
    expect(orderOf(orders, "C")).toEqual([]);
  });
  it("標準は保存順。保存順に無い（あとから登録した）カードは末尾に、登録の古い順で並ぶ", () => {
    expect(sortCards(rows, "default", orderOf(orders, "A")).map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
    expect(sortCards(rows, "default", orderOf(orders, "B")).map((r) => r.id)).toEqual(["b", "a", "c", "d"]);
  });
  it("プロフィールAとBの順序は独立している（同じカードを別の順に並べられる）", () => {
    expect(sortCards(rows, "default", orderOf(orders, "A")).map((r) => r.id)).not.toEqual(sortCards(rows, "default", orderOf(orders, "B")).map((r) => r.id));
  });
  it("保存順が無いプロフィールは、従来の標準（お気に入り→参考価値）のまま", () => {
    const legacy = [row("x", "2026-01-01", { favRank: null }), row("y", "2026-01-02", { favRank: 0 })];
    expect(sortCards(legacy, "default", []).map((r) => r.id)).toEqual(["y", "x"]);
    expect(sortCards(legacy, "default", null).map((r) => r.id)).toEqual(["y", "x"]);
  });
  it("ほかの並び順を選んでも保存順は影響を受けず、標準に戻すと復元される", () => {
    const saved = orderOf(orders, "A");
    const byName = sortCards(rows, "name", saved).map((r) => r.id);
    expect(byName).toEqual(["a", "b", "c", "d"]);
    expect(sortCards(rows, "default", saved).map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
    expect(saved).toEqual(["c", "a"]); // 並び順の切替で保存順（入力）は変わらない
  });
});

describe("Stage 6R: 支出の分類名・色", () => {
  it("一覧の短い名称はカード／サプライ／経費、フォームの品目名は周辺グッズ。内部IDは変わらない", () => {
    expect(EXPENSE_CATEGORIES.map((c) => [c.id, c.short])).toEqual([["pokemon_card", "カード"], ["goods", "サプライ"], ["expense", "経費"]]);
    expect(categoryOf("goods").label).toBe("周辺グッズ");
  });
  it("色は赤・青・緑の分類色", () => {
    expect(categoryOf("pokemon_card").color).toContain("--cat-card");
    expect(categoryOf("goods").color).toContain("--cat-supply");
    expect(categoryOf("expense").color).toContain("--cat-expense");
  });
});

describe("Stage 6R: 支出内訳の割合", () => {
  it("割合は整数%、1%未満は『1%未満』", () => {
    expect(percentLabel(12000, 18500)).toBe("65%");
    expect(percentLabel(10, 100000)).toBe("1%未満");
    expect(percentLabel(0, 0)).toBe("0%");
  });
});

const data = (): AppData =>
  ({
    products: [{ id: "p1", officialName: "30th CELEBRATION プレミアムデッキセット", aliases: ["30周年デッキ"] }],
    purchases: [
      { id: "u1", category: "pokemon_card", purchasedOn: { precision: "date_only", date: "2026-11-08" }, items: [{ id: "i1", productId: "p1", productLabel: null, quantity: 1, unit: "piece", amountPaid: 5500 }], source: "manual", channel: "store", storeId: null, note: "" },
      { id: "u2", category: "goods", purchasedOn: { precision: "date_only", date: "2026-10-02" }, items: [{ id: "i2", productId: null, productLabel: "スリーブ", quantity: 1, unit: "piece", amountPaid: 500 }], source: "manual", channel: "store", storeId: null, note: "" },
      { id: "u3", category: "expense", purchasedOn: { precision: "unknown" }, items: [{ id: "i3", productId: null, productLabel: "駐車場代", quantity: 1, unit: "piece", amountPaid: 300 }], source: "manual", channel: "other", storeId: null, note: "" },
    ],
    sales: [{ id: "s1", soldOn: "2025-05-05", platform: "x", productId: "p1", productLabel: null, quantity: 1, unit: "piece", amount: 9000, sellerProfileId: "pr", costAmount: null, costPurchaseItemId: null, costQuantity: null, fee: 0, shipping: 0, memo: "" }],
    stores: [],
    chains: [],
    profiles: [],
  }) as unknown as AppData;

describe("Stage 6R: 収支の商品名・全期間", () => {
  it("商品名はマスターの正式名称（略称・別名に置き換えない）", () => {
    const d = data();
    expect(productFullName(d, "p1")).toBe("30th CELEBRATION プレミアムデッキセット");
    expect(purchaseTitle(d, d.purchases[0])).toContain("30th CELEBRATION プレミアムデッキセット");
    expect(purchaseTitle(d, d.purchases[0])).not.toContain("30周年デッキ");
  });
  it("月を指定すると従来どおり、その月だけ", () => {
    const d = data();
    expect(ledgerEntries(d, "2026-11", "all").map((e) => e.id)).toEqual(["u1"]);
    expect(monthSummary(d, "2026-11")).toMatchObject({ expense: 5500, income: 0 });
  });
  it("全期間は、すべての取引（日付不明の支出も含む）と、収入・支出・内訳を全期間で集計する", () => {
    const d = data();
    expect(ledgerEntries(d, ALL_PERIOD, "all").map((e) => e.id).sort()).toEqual(["s1", "u1", "u2", "u3"]);
    const s = monthSummary(d, ALL_PERIOD);
    expect(s).toMatchObject({ expense: 6300, income: 9000, net: 2700 });
    expect(s.byCategory.map((c) => [c.category, c.amount]).sort()).toEqual([["expense", 300], ["goods", 500], ["pokemon_card", 5500]]);
  });
  it("全期間でも、すべて／支出／収入と品目の絞り込みを併用できる", () => {
    const d = data();
    expect(ledgerEntries(d, ALL_PERIOD, "expense").map((e) => e.id).sort()).toEqual(["u1", "u2", "u3"]);
    expect(ledgerEntries(d, ALL_PERIOD, "income").map((e) => e.id)).toEqual(["s1"]);
    expect(ledgerEntries(d, ALL_PERIOD, "all", "all", "goods").map((e) => e.id)).toEqual(["u2"]);
  });
});
