import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { buildUsageRecords, classifyPurchases, deriveBoxOpenings, filterUsage, proratedAmount, usageStats, usageTotals, ALL_USAGE, type LotRow, type MovementRow } from "@/lib/usage-records";
import type { AppData, BoxOpening, OpeningRecord, Purchase } from "@/types/domain";

// すべて架空のデータ。2026-11-09 (月) 12:00 JST
const NOW = new Date("2026-11-09T03:00:00Z");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const base = (): AppData => {
  const d = createMockData(NOW);
  return {
    ...d,
    products: [
      { id: "p-box", officialName: "30th CELEBRATION", aliases: ["30th"], code: "M6a", packsPerBox: 20 },
      { id: "p-nopack", officialName: "入数不明BOX", aliases: [], code: "", packsPerBox: null },
      { id: "p-pack", officialName: "単品パック商品", aliases: [], code: "", packsPerBox: null },
      { id: "p-deck", officialName: "スタートデッキ", aliases: [], code: "", packsPerBox: null },
    ] as never,
    productSetItems: [],
    purchases: [],
    boxOpenings: [],
    openingRecords: [],
    boxLotItemIds: [],
  };
};
const pk = (id: string, date: string, items: Purchase["items"], category = "pokemon_card"): Purchase => ({ id, applicationId: null, storeId: null, purchasedOn: { precision: "date_only", date }, channel: "store", source: "manual", items, note: "", category }) as Purchase;
const open = (o: Partial<BoxOpening> & { id: string }): BoxOpening => ({ opId: `op-${o.id}`, lotId: "lot1", productId: "p-box", quantity: 1, occurredAt: "2026-11-08T15:30:00Z", profileId: A, unitPrice: 7200, storeId: null, purchaseItemId: "i-box", ...o });
const rec = (o: Partial<OpeningRecord> & { id: string }): OpeningRecord => ({ productId: "p-pack", label: "", quantity: 1, unit: "pack", openedOn: "2026-11-05", amountYen: 150, profileId: A, purchaseItemId: null, note: "", ...o });

describe("Stage 7K: 開封・購入の記録の対象とタイミング", () => {
  it("購入・受取しただけの未開封BOXは記録に含めない（収支の購入には残る）", () => {
    const d = { ...base(), purchases: [pk("pu1", "2026-11-01", [{ id: "i-box", productId: "p-box", quantity: 3, unit: "box", amountPaid: 21600 }])], boxLotItemIds: ["i-box"] };
    expect(buildUsageRecords(d)).toEqual([]);
    expect(d.purchases).toHaveLength(1);
    expect(usageStats(buildUsageRecords(d))).toMatchObject({ box: 0, pack: 0, amount: 0 });
  });

  it("BOXを3BOX購入(21,600円)して1BOX開封: 開封1BOX・20パック・7,200円（購入単価）。未開封2BOXは含めない", () => {
    const d = { ...base(), purchases: [pk("pu1", "2026-11-01", [{ id: "i-box", productId: "p-box", quantity: 3, unit: "box", amountPaid: 21600 }])], boxLotItemIds: ["i-box"], boxOpenings: [open({ id: "m1" })] };
    const r = buildUsageRecords(d);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "open", source: "box_open", unit: "box", quantity: 1, packEquivalent: 20, amount: 7200, date: "2026-11-09", profileId: A, label: "30th CELEBRATION", purchaseItemId: "i-box" }); // 開封日=JST
    expect(usageStats(r)).toMatchObject({ box: 1, pack: 20, other: 0, amount: 7200, amountUnknown: 0 });
    const c = classifyPurchases(d);
    expect(c).toMatchObject({ opened: 1, unopened: 2, boxUnregistered: 0 });
  });

  it("入数(1BOXのパック数)が不明なBOXは、推測でパック換算しない。金額は集計する", () => {
    const d = { ...base(), boxOpenings: [open({ id: "m1", productId: "p-nopack", quantity: 2, unitPrice: 5000 })] };
    const r = buildUsageRecords(d);
    expect(r[0]).toMatchObject({ packEquivalent: null, amount: 10000 });
    expect(usageStats(r)).toMatchObject({ box: 2, pack: 0, packUnknownBoxes: 2, amount: 10000 });
    expect(usageTotals(r)[0]).toMatchObject({ boxes: 2, packEquivalent: null });
  });

  it("購入価格が異なる複数ロット: 開封したロットに対応する価格を使う（ロットごとに別の記録）", () => {
    const d = { ...base(), boxOpenings: [open({ id: "m1", lotId: "lotA", unitPrice: 7200, quantity: 1 }), open({ id: "m2", opId: "op-m1", lotId: "lotB", unitPrice: 8800, quantity: 1 })] };
    const r = buildUsageRecords(d);
    expect(r.map((x) => x.amount).sort()).toEqual([7200, 8800]);
    expect(usageStats(r).amount).toBe(16000);
  });

  it("購入単価が不明なロットの開封は、市場相場を使わず金額未設定（0円とみなさない）。総額に含めず件数を示す", () => {
    const d = { ...base(), boxOpenings: [open({ id: "m1", unitPrice: null })] };
    const r = buildUsageRecords(d);
    expect(r[0].amount).toBeNull();
    expect(usageStats(r)).toMatchObject({ box: 1, amount: 0, amountUnknown: 1 });
    expect(usageTotals(r)[0]).toMatchObject({ amount: 0, amountUnknown: 1 });
  });

  it("単品パック・セット商品の開封記録: パックは「パック」、セット・個は「その他商品」に数える", () => {
    const d = { ...base(), openingRecords: [rec({ id: "o1", quantity: 3, amountYen: 450 }), rec({ id: "o2", productId: "p-deck", unit: "set", quantity: 2, amountYen: 3000 }), rec({ id: "o3", productId: null, label: "自由入力の商品", unit: "piece", quantity: 1, amountYen: null })] };
    const r = buildUsageRecords(d);
    expect(r).toHaveLength(3);
    expect(usageStats(r)).toMatchObject({ box: 0, pack: 3, other: 3, single: 0, amount: 3450, amountUnknown: 1 });
  });

  it("シングルカードは購入した時点で記録（枚・購入日・金額）。「その他商品」には含めず、総額には含める", () => {
    const d = { ...base(), purchases: [pk("pu2", "2026-11-05", [{ id: "i-s", productId: null, productLabel: "ピカチュウ SAR", quantity: 2, unit: "piece", amountPaid: 4200 }], "single_card")] };
    const r = buildUsageRecords(d);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "single", source: "single_purchase", date: "2026-11-05", quantity: 2, amount: 4200, unit: "piece", category: "single_card" });
    expect(usageStats(r)).toMatchObject({ box: 0, pack: 0, other: 0, single: 2, amount: 4200 });
    // 金額が未入力のシングルカード購入は金額未設定
    const d2 = { ...d, purchases: [pk("pu3", "2026-11-05", [{ id: "i-s2", productId: null, productLabel: "ミュウ", quantity: 1, unit: "piece", amountPaid: null }], "single_card")] };
    expect(usageStats(buildUsageRecords(d2))).toMatchObject({ single: 1, amount: 0, amountUnknown: 1 });
  });

  it("カードコレクションへの登録や周辺グッズ・経費の購入は、購入記録を生成しない", () => {
    const d = { ...base(), purchases: [pk("g", "2026-11-05", [{ id: "ig", productId: null, productLabel: "スリーブ", quantity: 3, unit: "piece", amountPaid: 900 }], "goods"), pk("e", "2026-11-05", [{ id: "ie", productId: null, productLabel: "交通費", quantity: 1, unit: "piece", amountPaid: 500 }], "expense")] };
    expect(buildUsageRecords(d)).toEqual([]);
  });

  it("売却した商品は開封実績に加算されない（開封の操作だけが実績になる）", () => {
    // 売却は box_movements の sale 行で、開封の行ではない
    const mv: MovementRow[] = [
      { id: "s1", lot_id: "lot1", kind: "sale", qty: -1, op_id: null, reverts_op: null, occurred_at: "2026-11-08T00:00:00Z", created_by_profile_id: null },
      { id: "o1", lot_id: "lot1", kind: "open", qty: -1, op_id: "opA", reverts_op: null, occurred_at: "2026-11-08T05:00:00Z", created_by_profile_id: A },
    ];
    const lots: LotRow[] = [{ id: "lot1", product_id: "p-box", actual_unit_price: 7200, store_id: null, purchase_item_id: "i-box" }];
    const r = deriveBoxOpenings(mv, lots);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ opId: "opA", quantity: 1, unitPrice: 7200, profileId: A });
  });

  it("開封の取り消し: 取り消された操作は実績から除かれ、他の操作は残る。同じ操作の複数の行は1件にまとまる", () => {
    const mv: MovementRow[] = [
      { id: "o1", lot_id: "lot1", kind: "open", qty: -1, op_id: "opA", reverts_op: null, occurred_at: "2026-11-08T05:00:00Z", created_by_profile_id: A },
      { id: "r1", lot_id: "lot1", kind: "adjust", qty: 1, op_id: "opR", reverts_op: "opA", occurred_at: "2026-11-08T06:00:00Z", created_by_profile_id: A },
      { id: "o2", lot_id: "lot1", kind: "open", qty: -1, op_id: "opB", reverts_op: null, occurred_at: "2026-11-08T07:00:00Z", created_by_profile_id: B },
      { id: "o3", lot_id: "lot1", kind: "open", qty: -2, op_id: "opB", reverts_op: null, occurred_at: "2026-11-08T07:00:00Z", created_by_profile_id: B }, // 同じ操作・別の状態
    ];
    const r = deriveBoxOpenings(mv, [{ id: "lot1", product_id: "p-box", actual_unit_price: 7200, store_id: null, purchase_item_id: null }]);
    expect(r.map((x) => [x.opId, x.quantity])).toEqual([["opB", 3]]);
  });
});

describe("Stage 7K: 既存の購入履歴の分類と二重計上の防止", () => {
  const items = (): Purchase["items"] => [
    { id: "i-box", productId: "p-box", quantity: 3, unit: "box", amountPaid: 21600 },
    { id: "i-box2", productId: "p-box", quantity: 1, unit: "box", amountPaid: 7000 }, // BOXコレクション未登録
    { id: "i-pack", productId: "p-pack", quantity: 5, unit: "pack", amountPaid: 750 },
    { id: "i-deck", productId: "p-deck", quantity: 2, unit: "set", amountPaid: 3000 },
  ];
  it("開封済み／未開封／開封状態が不明に分ける。不明なものを勝手に開封済みにしない", () => {
    const d = { ...base(), purchases: [pk("pu", "2026-11-01", items())], boxLotItemIds: ["i-box"], boxOpenings: [open({ id: "m1", quantity: 1 })] };
    const c = classifyPurchases(d);
    expect(c.opened).toBe(1); // 開封1BOX（確認できるもの）
    expect(c.unopened).toBe(2); // 未開封2BOX
    expect(c.boxUnregistered).toBe(1);
    expect(c.unknown.map((u) => [u.itemId, u.remaining]).sort()).toEqual([["i-deck", 2], ["i-pack", 5]]);
    // 不明な購入は開封実績に入らない
    expect(buildUsageRecords(d).map((r) => r.source)).toEqual(["box_open"]);
  });
  it("不明な購入を開封済みと確認すると、その分だけ実績に加わり、不明の残りが減る。購入(収支)は変わらず二重にならない", () => {
    const purchases = [pk("pu", "2026-11-01", items())];
    const d = { ...base(), purchases, openingRecords: [rec({ id: "o1", productId: "p-pack", quantity: 2, amountYen: proratedAmount(750, 5, 2), purchaseItemId: "i-pack" })] };
    const c = classifyPurchases(d);
    expect(c.unknown.find((u) => u.itemId === "i-pack")!.remaining).toBe(3);
    expect(c.opened).toBe(2);
    const r = buildUsageRecords(d);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ source: "opening", quantity: 2, amount: 300, purchaseItemId: "i-pack", purchaseId: "pu" });
    // 収支側の購入は変わらない
    expect(d.purchases[0].items.find((i) => i.id === "i-pack")).toMatchObject({ quantity: 5, amountPaid: 750 });
    // 残り3パックも確認済みにすると不明が無くなる
    const d2 = { ...d, openingRecords: [...d.openingRecords, rec({ id: "o2", quantity: 3, amountYen: 450, purchaseItemId: "i-pack" })] };
    expect(classifyPurchases(d2).unknown.map((u) => u.itemId)).toEqual(["i-deck"]);
    expect(usageStats(buildUsageRecords(d2)).pack).toBe(5); // 5パック（購入数量を超えて数えない）
  });
  it("開封金額の按分: 購入金額が不明なら未設定のまま（市場相場を使わない）。円未満は四捨五入", () => {
    expect(proratedAmount(21600, 3, 1)).toBe(7200);
    expect(proratedAmount(1000, 3, 1)).toBe(333);
    expect(proratedAmount(1000, 3, 3)).toBe(1000);
    expect(proratedAmount(null, 3, 1)).toBeNull();
  });
});

describe("Stage 7K: 絞り込み・集計", () => {
  const data = (): AppData => ({
    ...base(),
    purchases: [pk("pu2", "2026-10-20", [{ id: "i-s", productId: null, productLabel: "ピカチュウ", quantity: 2, unit: "piece", amountPaid: 4200 }], "single_card")],
    boxOpenings: [open({ id: "m1", occurredAt: "2026-11-08T15:30:00Z" /* JST 11/9 */, profileId: A }), open({ id: "m2", occurredAt: "2026-10-31T16:00:00Z" /* JST 11/1 */, profileId: B, quantity: 2, unitPrice: 7000 })],
    openingRecords: [rec({ id: "o1", openedOn: "2026-11-05", quantity: 4, amountYen: 600, profileId: A })],
  });
  const f = (p: Partial<Parameters<typeof filterUsage>[1]>) => ({ ...ALL_USAGE, period: { kind: "all" as const, value: "" }, ...p });
  it("月別: 開封は開封日、シングルカードは購入日で数える", () => {
    const all = buildUsageRecords(data());
    expect(filterUsage(all, f({ period: { kind: "month", value: "2026-11" } })).map((r) => r.source).sort()).toEqual(["box_open", "box_open", "opening"]);
    expect(filterUsage(all, f({ period: { kind: "month", value: "2026-10" } })).map((r) => r.source)).toEqual(["single_purchase"]);
    expect(usageStats(filterUsage(all, f({ period: { kind: "all", value: "" } }))).amount).toBe(7200 + 14000 + 600 + 4200);
  });
  it("分類（開封／シングルカード）とプロフィールで絞り込む。上部集計・累計・履歴に同じ条件を使う", () => {
    const all = buildUsageRecords(data());
    expect(filterUsage(all, f({ kind: "single" })).map((r) => r.kind)).toEqual(["single"]);
    expect(filterUsage(all, f({ kind: "open" })).every((r) => r.kind === "open")).toBe(true);
    const forA = filterUsage(all, f({ profileId: A }));
    expect(forA.every((r) => r.profileId === A)).toBe(true);
    expect(usageStats(forA)).toMatchObject({ box: 1, pack: 20 + 4, amount: 7200 + 600 }); // シングルカード（プロフィールなし）は絞り込み中は含めない
    const forB = filterUsage(all, f({ profileId: B }));
    expect(usageStats(forB)).toMatchObject({ box: 2, pack: 40, amount: 14000 });
  });
  it("商品別累計: 20パック／開封1BOX／総額7,200円。商品名は正式名称", () => {
    const t = usageTotals(buildUsageRecords({ ...base(), boxOpenings: [open({ id: "m1" })] }));
    expect(t[0]).toMatchObject({ label: "30th CELEBRATION", boxes: 1, packs: 20, packEquivalent: 20, amount: 7200 });
  });
});
