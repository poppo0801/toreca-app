import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { dateOnly } from "@/lib/datetime";
import { productPurchaseStats } from "@/lib/finance";
import type { AppData } from "@/types/domain";

describe("商品別購入実績（セット構成・二重計上なし）", () => {
  const base = createMockData(new Date("2026-10-28T03:00:00Z"));
  const data: AppData = {
    ...base,
    purchases: [
      { id: "x1", applicationId: null, storeId: null, purchasedOn: dateOnly("2026-10-01"), channel: "store", source: "manual", note: "", items: [{ productId: "p1", quantity: 2, unit: "box", amountPaid: 12000 }] },
      // p3 がセット商品（p1×2 + p2×1 を含む構成）。2セット購入
      { id: "x2", applicationId: null, storeId: null, purchasedOn: dateOnly("2026-10-05"), channel: "store", source: "manual", note: "", items: [{ productId: "p3", quantity: 2, unit: "set", amountPaid: 21600 }] },
      { id: "x3", applicationId: null, storeId: null, purchasedOn: dateOnly("2025-01-05"), channel: "store", source: "manual", note: "", items: [{ productId: "p1", quantity: 9, unit: "box", amountPaid: 1 }] },
    ],
    productSetItems: [
      { id: "s1", setProductId: "p3", componentProductId: "p1", quantity: 2 },
      { id: "s2", setProductId: "p3", componentProductId: "p2", quantity: 1 },
    ],
  };

  it("セットの金額・数量はセット商品にだけ計上し、構成商品には数量(参考)だけを加える", () => {
    const rows = Object.fromEntries(productPurchaseStats(data, 2026).map((r) => [r.productId, r]));
    expect(rows.p3).toMatchObject({ direct: { set: 2 }, directAmount: 21600, viaSet: 0 });
    // p1: 直接 2BOX/12,000円。セット経由は 2セット×2 = 4点（金額は加算しない）
    expect(rows.p1).toMatchObject({ direct: { box: 2 }, directAmount: 12000, viaSet: 4 });
    // p2: 直接の購入はなく、セット経由のみ。金額は0
    expect(rows.p2).toMatchObject({ direct: {}, directAmount: 0, viaSet: 2 });
    // 合計金額は支出の実額(33,600円)のまま。構成商品へ配った分を足すと二重計上になる
    expect(Object.values(rows).reduce((a, r) => a + r.directAmount, 0)).toBe(33600);
  });

  it("構成が未登録のセットは構成商品へ何も加えない。対象年外・金額未入力を区別する", () => {
    const none = productPurchaseStats({ ...data, productSetItems: [] }, 2026);
    expect(none.find((r) => r.productId === "p2")).toBeUndefined();
    expect(productPurchaseStats(data, 2025)).toHaveLength(1);
    const unknown = productPurchaseStats({ ...data, purchases: [{ ...data.purchases[0], items: [{ productId: "p1", quantity: 1, unit: "box", amountPaid: null }] }] }, 2026);
    expect(unknown[0]).toMatchObject({ directAmount: 0, directAmountUnknown: 1 });
  });

  it("モック等で構成データが無くても動く（既存データとの互換）", () => {
    const { productSetItems: _omit, ...rest } = data;
    void _omit;
    expect(() => productPurchaseStats(rest as AppData, 2026)).not.toThrow();
  });
});
