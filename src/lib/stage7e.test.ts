import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { categoryOf, EXPENSE_CATEGORIES, isCardPurchase, isPurchaseRecord, isSingleCard } from "@/lib/expense-category";
import { purchaseTitle, unitLabelFor } from "@/lib/finance";
import { filterPurchases, ALL_PURCHASES, isSingleItem, productTotals, purchaseStats, quantityLabel, summarize } from "@/lib/purchase-records";
import type { AppData, Purchase } from "@/types/domain";

const NOW = new Date("2026-11-08T03:00:00Z");

describe("Stage 7E: 支出の品目（5分類）", () => {
  it("ポケモンカード(赤)・シングルカード(オレンジ)・周辺グッズ(青)・経費(緑)・その他(グレー)。既存の3分類のIDと色は変わらない", () => {
    expect(EXPENSE_CATEGORIES.map((c) => c.id)).toEqual(["pokemon_card", "single_card", "goods", "expense", "other"]);
    expect(EXPENSE_CATEGORIES.map((c) => c.label)).toEqual(["ポケモンカード", "シングルカード", "周辺グッズ", "経費", "その他"]);
    expect(categoryOf("pokemon_card").color).toContain("--cat-card");
    expect(categoryOf("goods").color).toContain("--cat-supply");
    expect(categoryOf("expense").color).toContain("--cat-expense");
    expect(categoryOf("single_card").color).toContain("--cat-single");
    expect(categoryOf("other").color).toContain("--cat-other");
    expect(new Set(EXPENSE_CATEGORIES.map((c) => c.color)).size).toBe(5);
  });
  it("シングルカードの単位は「枚」。保存は個(piece)のまま表示だけ枚。他の品目は従来の単位名", () => {
    expect(isSingleCard("single_card")).toBe(true);
    expect(isSingleCard("pokemon_card")).toBe(false);
    expect(unitLabelFor("piece", "single_card")).toBe("枚");
    expect(unitLabelFor("piece", "goods")).toBe("個");
    expect(unitLabelFor("box", "single_card")).toBe("枚"); // シングルカードは枚で固定
    expect(unitLabelFor("box", "pokemon_card")).toBe("BOX");
  });
  it("購入記録に載せる品目はポケモンカード・シングルカード・その他。購入条件・売却原価の対象（isCardPurchase）はポケモンカードのまま変えない", () => {
    expect(isPurchaseRecord({ category: "single_card" })).toBe(true);
    expect(isPurchaseRecord({ category: "other" })).toBe(true);
    expect(isPurchaseRecord({ category: "pokemon_card" })).toBe(true);
    expect(isPurchaseRecord({})).toBe(true);
    expect(isPurchaseRecord({ category: "goods" })).toBe(false);
    expect(isPurchaseRecord({ category: "expense" })).toBe(false);
    expect(isCardPurchase({ category: "single_card" })).toBe(false);
    expect(isCardPurchase({ category: "other" })).toBe(false);
  });
});

describe("Stage 7E: 購入記録の集計（BOX・パック・その他商品・総額）", () => {
  const d = createMockData(NOW);
  const pk = (id: string, date: string, items: Purchase["items"], category = "pokemon_card"): Purchase => ({
    id, applicationId: null, storeId: null, purchasedOn: { precision: "date_only", date }, channel: "store", source: "manual", items, note: "", category,
  });
  const data: AppData = {
    ...d,
    products: [
      ...d.products,
      { id: "p-box", officialName: "30th CELEBRATION", aliases: [], code: "", packsPerBox: 20 },
      { id: "p-box2", officialName: "別のBOX", aliases: [], code: "", packsPerBox: 30 },
      { id: "p-nopack", officialName: "入数不明BOX", aliases: [], code: "", packsPerBox: null },
      { id: "p-deck", officialName: "スタートデッキセット", aliases: [], code: "", packsPerBox: null },
      { id: "p-comp", officialName: "構成商品", aliases: [], code: "", packsPerBox: null },
    ],
    productSetItems: [{ id: "ps1", setProductId: "p-deck", componentProductId: "p-comp", quantity: 3 }],
    purchases: [
      pk("a", "2026-11-01", [{ id: "i1", productId: "p-box", quantity: 3, unit: "box", amountPaid: 21600 }]),
      pk("b", "2026-11-02", [{ id: "i2", productId: "p-box", quantity: 4, unit: "pack", amountPaid: 600 }]),
      pk("c", "2026-11-03", [{ id: "i3", productId: "p-box2", quantity: 2, unit: "box", amountPaid: 10000 }]),
      pk("d", "2026-11-04", [{ id: "i4", productId: "p-deck", quantity: 3, unit: "set", amountPaid: 9000 }]),
      pk("e", "2026-11-05", [{ id: "i5", productId: null, productLabel: "ピカチュウ", quantity: 6, unit: "piece", amountPaid: 6260 }], "single_card"),
      pk("f", "2026-11-06", [{ id: "i6", productId: "p-nopack", quantity: 1, unit: "box", amountPaid: 5400 }]),
      pk("g", "2026-11-07", [{ id: "i7", productId: null, productLabel: "ストレージ", quantity: 1, unit: "piece", amountPaid: 1000 }], "other"),
      pk("h", "2026-11-07", [{ id: "i8", productId: null, productLabel: "スリーブ", quantity: 5, unit: "piece", amountPaid: 700 }], "goods"),
    ],
  };
  const list = () => filterPurchases(data, ALL_PURCHASES);

  it("周辺グッズは購入記録に載らない。ポケモンカード・シングルカード・その他は載る", () => {
    expect(list().map((p) => p.id).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });
  it("BOXの合計数量、BOX換算込みのパック総数（入数が不明なBOXは換算しない）、その他商品（デッキ・セット）、総額", () => {
    const s = purchaseStats(data, list());
    expect(s.box).toBe(3 + 2 + 1);
    expect(s.pack).toBe(3 * 20 + 4 + 2 * 30); // 3BOX×20 + 単品4 + 2BOX×30 = 124。入数不明の1BOXは含めない
    expect(s.packUnknownBoxes).toBe(1);
    expect(s.other).toBe(3); // スタートデッキセット3個のみ
    expect(s.single).toBe(6);
    expect(s.amount).toBe(21600 + 600 + 10000 + 9000 + 6260 + 5400 + 1000);
  });
  it("シングルカードは『その他商品』に混入しない。支出品目『その他』も『その他商品』に入らない", () => {
    const only = (id: string) => purchaseStats(data, list().filter((p) => p.id === id));
    expect(only("e").other).toBe(0);
    expect(only("e").single).toBe(6);
    expect(only("g").other).toBe(0);
    expect(only("d").other).toBe(3);
  });
  it("BOXをパックに換算しても金額は二重計上しない（総額は購入明細の合計と一致）", () => {
    const s = purchaseStats(data, list());
    expect(s.amount).toBe(summarize(list()).amount);
  });
  it("旧データのシングル（ポケモンカード品目の『シングルカード』自由入力）もシングルとして数え、その他商品に混ぜない", () => {
    const legacy = pk("z", "2026-11-08", [{ id: "iz", productId: null, productLabel: "シングルカード", quantity: 2, unit: "piece", amountPaid: 300 }]);
    expect(isSingleItem(legacy, legacy.items[0])).toBe(true);
    const s = purchaseStats(data, [legacy]);
    expect(s.other).toBe(0);
    expect(s.single).toBe(2);
  });
  it("期間・店舗・商品の絞り込みに応じて集計が変わる", () => {
    const nov2 = filterPurchases(data, { ...ALL_PURCHASES, period: { kind: "month", value: "2026-11" }, productId: "p-box" });
    expect(purchaseStats(data, nov2).box).toBe(3);
    expect(purchaseStats(data, filterPurchases(data, { ...ALL_PURCHASES, period: { kind: "month", value: "2026-10" } })).box).toBe(0);
  });
  it("数量表記は数量が先・単位が後（3BOX・2パック・6個・3枚）", () => {
    expect(quantityLabel({ quantity: 3, unit: "box" })).toBe("3BOX");
    expect(quantityLabel({ quantity: 2, unit: "pack" })).toBe("2パック");
    expect(quantityLabel({ quantity: 6, unit: "piece" })).toBe("6個");
    expect(quantityLabel({ quantity: 3, unit: "piece" }, "single_card")).toBe("3枚");
    expect(purchaseTitle(data, data.purchases[4])).toContain("6枚");
  });

  describe("商品別の累計", () => {
    it("商品マスターIDで集計し、BOX×入数＋単品パックを累計パック数とする。購入総額はBOX換算で増えない", () => {
      const t = productTotals(data, list());
      const box = t.find((r) => r.productId === "p-box")!;
      expect(box.packEquivalent).toBe(64); // 3×20 + 4
      expect(box.direct).toEqual({ box: 3, pack: 4 });
      expect(box.amount).toBe(22200);
    });
    it("セット商品は個数と金額を計上し、構成商品へは数量のみ（金額は二重計上しない）。数量の多い順に並ぶ", () => {
      const t = productTotals(data, list());
      expect(t.find((r) => r.productId === "p-deck")).toMatchObject({ amount: 9000, direct: { set: 3 } });
      expect(t.find((r) => r.productId === "p-comp")).toMatchObject({ amount: 0, viaSet: 9 });
      expect(t.reduce((n, r) => n + r.amount, 0)).toBe(summarize(list()).amount);
      expect(t[0].productId).toBe("p-box"); // 64パックが最多
    });
    it("マスター未紐づけのシングルカードは名称の一致するものだけをまとめ、類似名の別カードは統合しない。入数不明のBOXは換算しない", () => {
      const more = pk("e2", "2026-11-06", [{ id: "j1", productId: null, productLabel: "ピカチュウ ", quantity: 1, unit: "piece", amountPaid: 100 }, { id: "j2", productId: null, productLabel: "ピカチュウex", quantity: 1, unit: "piece", amountPaid: 100 }], "single_card");
      const t = productTotals({ ...data, purchases: [...data.purchases, more] }, filterPurchases({ ...data, purchases: [...data.purchases, more] }, ALL_PURCHASES));
      const pika = t.find((r) => r.label === "ピカチュウ")!;
      expect(pika).toMatchObject({ single: true, direct: { piece: 7 }, amount: 6360 });
      expect(t.find((r) => r.label === "ピカチュウex")?.direct.piece).toBe(1);
      expect(t.find((r) => r.productId === "p-nopack")!.packEquivalent).toBeNull();
    });
    it("売却・開封・譲渡で過去の購入数量は減らない（購入実績の累計。現在の所有数はコレクションで管理）", () => {
      const before = productTotals(data, list()).find((r) => r.productId === "p-box")!.packEquivalent;
      const sold: AppData = { ...data, sales: [{ id: "s1", soldOn: "2026-11-08", platform: "x", productId: "p-box", productLabel: null, quantity: 2, unit: "box", amount: 20000, sellerProfileId: "pA", costAmount: null, costPurchaseItemId: null, costQuantity: null, fee: 0, shipping: 0, memo: "" } as never] };
      expect(productTotals(sold, filterPurchases(sold, ALL_PURCHASES)).find((r) => r.productId === "p-box")!.packEquivalent).toBe(before);
    });
  });
});
