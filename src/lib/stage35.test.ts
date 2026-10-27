import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { dateTime } from "@/lib/datetime";
import { annualStats, costCandidates, ledgerEntries, monthSummary, proratedCost, purchaseTotal, remainingCostQty, shiftMonth, suggestedAmount } from "@/lib/finance";
import { expenseSchema, saleSchema } from "@/lib/finance-input";
import { EMPTY_FLEX, lotteryInputSchema, validateMultiMode } from "@/lib/lottery-input";
import { DEFAULT_FILTERS, formatItem, selectLotteries } from "@/lib/lottery-view";
import { applicantsFor, computeAlerts, planNotifications, recipientsOf, tabDots } from "@/lib/notifications";
import type { AppData, Lottery, Purchase, Sale } from "@/types/domain";

/** 2026-10-26 12:00 JST */
const NOW = new Date("2026-10-26T03:00:00Z");
const mins = (n: number) => dateTime(new Date(NOW.getTime() + n * 60000).toISOString());
const uuid = "123e4567-e89b-42d3-a456-426614174000";

/** L4（A・Bが対象、Cは対象外の系列）を締切100分後にした状態 */
function withL4(patch: Partial<Lottery> = {}, mutate?: (d: AppData) => AppData): AppData {
  const d = createMockData(NOW);
  const out = { ...d, lotteries: d.lotteries.map((l) => (l.id === "L4" ? { ...l, applyDeadline: mins(100), ...patch } : l)) };
  return mutate ? mutate(out) : out;
}
const setRecipients = (d: AppData, id: string, ids: string[] | null): AppData => ({
  ...d,
  profiles: d.profiles.map((p) => (p.id === id ? { ...p, notifyRecipientIds: ids } : p)),
});
const dueL4 = (d: AppData) => planNotifications(d, {}, NOW).due.filter((n) => n.lotteryId === "L4");

describe("通知先と応募ユーザーの分離", () => {
  it("既定は本人宛て（未設定=本人のみ、空配列=通知なし）", () => {
    const d = createMockData(NOW);
    expect(recipientsOf(d.profiles[0])).toEqual(["pA"]);
    expect(recipientsOf({ id: "pA", notifyRecipientIds: [] })).toEqual([]);
    expect(applicantsFor(d, "pB").map((p) => p.id)).toEqual(["pB"]);
  });

  it("Bの通知先をAにすると、Aに1件にまとめて届き、本文に未対応のユーザー名が入る。Bには届かない", () => {
    const d = setRecipients(withL4(), "pB", ["pA"]);
    const n = dueL4(d);
    expect(n.filter((x) => x.profileId === "pB")).toHaveLength(0);
    const a = n.filter((x) => x.profileId === "pA");
    expect(a).toHaveLength(1); // 同じ抽選・同じタイミングはA宛て1件
    expect(a[0].body).toContain("未応募: A、B");
  });

  it("Aがその抽選をスルーしても、Aが通知担当のBの応募漏れ通知は止まらない（スルーはユーザー別）", () => {
    const d = setRecipients(
      withL4({}, (x) => ({ ...x, skipRules: [...x.skipRules, { id: "skx", profileId: "pA", scope: "lottery", scopeId: "L4", exceptionLotteryIds: [] }] })),
      "pB",
      ["pA"],
    );
    const a = dueL4(d).filter((x) => x.profileId === "pA");
    expect(a).toHaveLength(1);
    expect(a[0].body).toContain("未応募: B");
    expect(a[0].body).not.toContain("A、");
  });

  it("通知なしを選ぶと送らない。同一タイミングの再計算でも triggerKey は同じ（二重送信防止）", () => {
    const d = setRecipients(withL4(), "pB", []);
    expect(dueL4(d).filter((x) => x.profileId === "pB")).toHaveLength(0);
    const k1 = dueL4(d).map((x) => `${x.profileId}|${x.triggerKey}`);
    const k2 = dueL4(d).map((x) => `${x.profileId}|${x.triggerKey}`);
    expect(k2).toEqual(k1);
  });

  it("アプリ内通知（ベル）も通知先の設定に従い、件数は抽選単位", () => {
    const d = setRecipients(withL4(), "pB", ["pA"]);
    const alertsA = computeAlerts(d, "pA", NOW).filter((a) => a.lotteryId === "L4");
    expect(alertsA).toHaveLength(1);
    expect(alertsA[0].detail).toContain("A、B");
    expect(computeAlerts(d, "pB", NOW).filter((a) => a.lotteryId === "L4")).toHaveLength(0);
  });
});

describe("当落未確認・購入未完了の表示と複数商品の重複計上", () => {
  it("発表日を過ぎた結果待ちで応募済みタブの●、当選未購入で当選タブの●", () => {
    const d = createMockData(NOW);
    const dots = tabDots(d, "pA", NOW);
    expect(typeof dots.appliedDot).toBe("boolean");
    const later = new Date(NOW.getTime() + 30 * 86400_000);
    expect(tabDots(d, "pA", later).appliedDot).toBe(true);
    expect(tabDots(d, "pA", NOW).wonDot).toBe(true); // ap5: Aの当選・未購入
    expect(tabDots(d, "pB", NOW).wonDot).toBe(false); // Bは購入済み/落選のみ
  });

  it("1応募に複数商品があってもアラートは抽選単位で1件", () => {
    const d = createMockData(NOW);
    const later = new Date(NOW.getTime() + 30 * 86400_000);
    const l3Items = d.lotteries.find((l) => l.id === "L3")!.items.length;
    expect(l3Items).toBe(2);
    const alerts = computeAlerts(d, "pA", later).filter((a) => a.lotteryId === "L3" && a.kind === "result_overdue");
    expect(alerts).toHaveLength(1);
  });
});

describe("スルー表示フィルター（★管理対象）", () => {
  const d = createMockData(NOW);
  const skipped = { ...d, skipRules: [...d.skipRules, { id: "sk2", profileId: "pA", scope: "lottery" as const, scopeId: "L4", exceptionLotteryIds: [] }] };
  const ids = (skip: "normal" | "include" | "only", profile: string) =>
    selectLotteries(skipped, "managed", { ...DEFAULT_FILTERS, skip }, NOW, profile).map((l) => l.id);
  it("通常=自分がスルーしていないもの / 含む=すべて / のみ=自分がスルーしたもの", () => {
    expect(ids("normal", "pA")).not.toContain("L4");
    expect(ids("include", "pA")).toContain("L4");
    expect(ids("only", "pA")).toEqual(expect.arrayContaining(["L4"]));
    expect(ids("only", "pA")).not.toContain("L2");
  });
  it("他のユーザーには影響しない", () => {
    expect(ids("normal", "pB")).toContain("L4");
    expect(ids("only", "pB")).not.toContain("L4");
  });
  it("商品フィルターは複数商品の抽選もいずれかの明細で絞り込める", () => {
    const l3 = d.lotteries.find((l) => l.id === "L3")!;
    const second = l3.items[1].productId;
    const r = selectLotteries(d, "all", { ...DEFAULT_FILTERS, productId: second }, NOW, "pA").map((l) => l.id);
    expect(r).toContain("L3");
  });
});

describe("抽選入力: 未登録マスターの自由入力と抽選方式", () => {
  const base = {
    chain: { id: null, name: "新しい系列" },
    store: { id: null, name: "新しい店舗", prefecture: "" },
    multiMode: "single" as const,
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: null, name: "仮の商品名" }, quantity: 1, unit: "box" as const }],
    applyStart: EMPTY_FLEX,
    applyDeadline: EMPTY_FLEX,
    resultDate: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "unknown" as const,
    applyMethod: "unknown" as const,
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open" as const,
    limitBasis: "unknown" as const,
    limitMaxCount: 1,
    memo: "",
  };
  it("マスター未登録の系列・店舗・商品名だけで受理される（商品番号・価格などは不要）", () => {
    expect(lotteryInputSchema.safeParse(base).success).toBe(true);
  });
  it("名称も既存選択も無いマスター参照は拒否", () => {
    expect(lotteryInputSchema.safeParse({ ...base, chain: { id: null, name: "  " } }).success).toBe(false);
    expect(lotteryInputSchema.safeParse({ ...base, items: [{ product: { id: null, name: "" }, quantity: 1, unit: "box" }] }).success).toBe(false);
    expect(lotteryInputSchema.safeParse({ ...base, chain: { id: uuid, name: "" } }).success).toBe(true);
  });
  it("方式と明細数: 単一は1商品、B/C/Dは2商品以上", () => {
    expect(validateMultiMode("single", 1)).toBeNull();
    expect(validateMultiMode("single", 2)).not.toBeNull();
    for (const m of ["all", "one_win", "choose_one"] as const) {
      expect(validateMultiMode(m, 1)).not.toBeNull();
      expect(validateMultiMode(m, 3)).toBeNull();
    }
  });
});

describe("仮登録商品の表示", () => {
  it("仮登録の商品は入数が未確認なのでパック換算を表示しない", () => {
    const prov = { id: "x", officialName: "仮商品", aliases: [], code: "", packsPerBox: 30, provisional: true };
    expect(formatItem({ quantity: 2, unit: "box" }, prov)).toBe("仮商品 2BOX");
    expect(formatItem({ quantity: 2, unit: "box" }, { ...prov, provisional: false })).toBe("仮商品 2BOX (60P)");
  });
});

// ------------------------------------------------------------------ 収支
const pur = (id: string, date: string, items: Purchase["items"], extra: Partial<Purchase> = {}): Purchase => ({
  id,
  applicationId: null,
  storeId: null,
  purchasedOn: { precision: "date_only", date },
  channel: "store",
  source: "manual",
  items,
  note: "",
  ...extra,
});
const sale = (id: string, soldOn: string, amount: number, seller: string, extra: Partial<Sale> = {}): Sale => ({
  id,
  soldOn,
  platform: "",
  productId: null,
  productLabel: "商品",
  quantity: 1,
  unit: "box",
  amount,
  sellerProfileId: seller,
  costAmount: null,
  costPurchaseItemId: null,
  costQuantity: null,
  fee: 0,
  shipping: 0,
  memo: "",
  ...extra,
});
const finData = (purchases: Purchase[], sales: Sale[]): AppData => ({ ...createMockData(NOW), purchases, sales });

describe("収支: 月次集計と金額の仮計算", () => {
  it("定価から数量分を仮計算（BOX/パック）。定価なし・セットは推測しない", () => {
    const p = { listPriceBox: 5400, listPricePack: 180 };
    expect(suggestedAmount(p, "pack", 5)).toBe(900);
    expect(suggestedAmount(p, "box", 2)).toBe(10800);
    expect(suggestedAmount(p, "set", 1)).toBeNull();
    expect(suggestedAmount({ listPriceBox: null, listPricePack: null }, "box", 1)).toBeNull();
    expect(suggestedAmount(undefined, "box", 1)).toBeNull();
  });

  it("月間の支出・収入・収支。金額未入力の購入は0円とみなさず別に数える", () => {
    const d = finData(
      [
        pur("p1", "2026-10-03", [{ productId: null, productLabel: "A", quantity: 1, unit: "box", amountPaid: 5400 }]),
        pur("p2", "2026-10-10", [{ productId: null, productLabel: "B", quantity: 1, unit: "box", amountPaid: null }]),
        pur("p3", "2026-09-30", [{ productId: null, productLabel: "C", quantity: 1, unit: "box", amountPaid: 9999 }]),
      ],
      [sale("s1", "2026-10-15", 8000, "pA"), sale("s2", "2026-11-01", 1000, "pA")],
    );
    expect(monthSummary(d, "2026-10")).toEqual({ expense: 5400, income: 8000, net: 2600, expenseUnknown: 1 });
    expect(monthSummary(d, "2026-09").expense).toBe(9999);
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("すべて/支出/収入と売却名義人の絞り込み", () => {
    const d = finData(
      [pur("p1", "2026-10-03", [{ productId: null, productLabel: "A", quantity: 1, unit: "box", amountPaid: 100 }])],
      [sale("s1", "2026-10-05", 500, "pA"), sale("s2", "2026-10-06", 700, "pB")],
    );
    expect(ledgerEntries(d, "2026-10", "all")).toHaveLength(3);
    expect(ledgerEntries(d, "2026-10", "expense").map((e) => e.kind)).toEqual(["expense"]);
    expect(ledgerEntries(d, "2026-10", "income")).toHaveLength(2);
    expect(ledgerEntries(d, "2026-10", "income", "pB").map((e) => e.id)).toEqual(["s2"]);
  });

  it("抽選由来の購入と手入力の購入は同じ購入データなので、収支に1回ずつだけ入る", () => {
    const d = createMockData(NOW);
    const before = monthSummary({ ...d, purchases: d.purchases }, "2026-10");
    const dup = monthSummary({ ...d, purchases: [...d.purchases] }, "2026-10");
    expect(dup).toEqual(before);
    expect(purchaseTotal({ items: [{ productId: null, quantity: 1, unit: "box", amountPaid: 100 }, { productId: null, quantity: 1, unit: "box", amountPaid: 200 }] }).total).toBe(300);
  });
});

describe("売却: 原価の重複計上防止と年間集計", () => {
  const purchases = [pur("p1", "2026-02-01", [{ id: "pi1", productId: null, productLabel: "A", quantity: 4, unit: "box", amountPaid: 20000 }])];

  it("購入明細の残り数量と按分原価。購入金額が未入力なら原価は未確定(null)", () => {
    const d = finData(purchases, [sale("s1", "2026-03-01", 9000, "pA", { costPurchaseItemId: "pi1", costQuantity: 3, costAmount: 15000 })]);
    expect(remainingCostQty(d, "pi1")).toBe(1);
    expect(remainingCostQty(d, "pi1", "s1")).toBe(4); // 編集中の売却自身は除く
    expect(costCandidates(d).map((c) => c.remaining)).toEqual([1]);
    expect(proratedCost(20000, 4, 1)).toBe(5000);
    expect(proratedCost(null, 4, 1)).toBeNull();
  });

  it("全数量を使い切った購入は候補に出ない", () => {
    const d = finData(purchases, [sale("s1", "2026-03-01", 9000, "pA", { costPurchaseItemId: "pi1", costQuantity: 4, costAmount: 20000 })]);
    expect(costCandidates(d)).toHaveLength(0);
  });

  it("年間集計: 原価未設定は0円扱いせず利益未確定として分離。名義人別と合計", () => {
    const d = finData(purchases, [
      sale("s1", "2026-03-01", 10000, "pA", { costAmount: 6000, fee: 500, shipping: 300 }),
      sale("s2", "2026-04-01", 4000, "pA"), // 原価未設定
      sale("s3", "2026-05-01", 7000, "pB", { costAmount: 0 }), // 原価0円と明示
      sale("s4", "2025-12-31", 99999, "pA"), // 対象年外
    ]);
    const { total, bySeller } = annualStats(d, 2026);
    expect(total.salesAmount).toBe(21000);
    expect(total.salesCount).toBe(3);
    expect(total.costUnknownCount).toBe(1);
    expect(total.amountCostUnknown).toBe(4000);
    expect(total.profitKnown).toBe(10000 - 6000 - 500 - 300 + 7000);
    const a = bySeller.find((s) => s.sellerProfileId === "pA")!;
    expect(a.profitKnown).toBe(3200);
    expect(a.costUnknownCount).toBe(1);
    expect(bySeller.find((s) => s.sellerProfileId === "pB")!.profitKnown).toBe(7000);
  });
});

describe("収支の入力検証", () => {
  const expense = {
    date: "2026-10-26",
    store: { id: null, name: "どこかの店" },
    channel: "store" as const,
    note: "",
    items: [{ product: { id: null, name: "フリーテキスト商品" }, quantity: 5, unit: "pack" as const, amountPaid: 900 }],
  };
  it("マスターにない商品・店舗の自由入力を許可し、金額不明(null)も許す", () => {
    expect(expenseSchema.safeParse(expense).success).toBe(true);
    expect(expenseSchema.safeParse({ ...expense, items: [{ ...expense.items[0], amountPaid: null }] }).success).toBe(true);
  });
  it("数量1未満・金額マイナス・日付なしは拒否", () => {
    expect(expenseSchema.safeParse({ ...expense, items: [{ ...expense.items[0], quantity: 0 }] }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...expense, items: [{ ...expense.items[0], amountPaid: -1 }] }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...expense, date: "" }).success).toBe(false);
  });
  it("売却: 名義人必須、原価は未設定(null)可、原価紐づけは購入明細と数量の両方が必要な形で受理", () => {
    const s = {
      soldOn: "2026-10-26", platform: "買取店", product: { id: null, name: "商品" }, quantity: 1, unit: "box" as const,
      amount: 8000, sellerProfileId: uuid, costAmount: null, costPurchaseItemId: null, costQuantity: null, fee: 0, shipping: 0, memo: "",
    };
    expect(saleSchema.safeParse(s).success).toBe(true);
    expect(saleSchema.safeParse({ ...s, sellerProfileId: "" }).success).toBe(false);
    expect(saleSchema.safeParse({ ...s, amount: -1 }).success).toBe(false);
  });
});
