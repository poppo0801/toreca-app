import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { BATTLE_RESULT_LABEL, battleInputSchema, filterBattles, sortBattles, tally, tallyBy, EMPTY_BATTLE_FILTER } from "@/lib/battle";
import { filterPurchases, ALL_PURCHASES, productTotals, shiftPeriod, summarize } from "@/lib/purchase-records";
import { computeWinStats, formatRate } from "@/lib/win-rate";
import type { AppData, Application, BattleRecord, Lottery, Purchase, ResultStatus } from "@/types/domain";

const NOW = new Date("2026-10-26T03:00:00Z");
const uuid = "123e4567-e89b-42d3-a456-426614174000";

// ---------------------------------------------------------------- 当選率
function base() {
  const d = createMockData(NOW);
  const chainId = d.lotteries[0].chainId;
  const storeId = d.lotteries[0].storeId;
  const acc = (p: string) => d.accounts.find((a) => a.profileId === p && a.chainId === chainId)!.id;
  const lot = (id: string, over: Partial<Lottery>): Lottery => ({ ...d.lotteries[0], id, chainId, storeId, applyDeadline: { precision: "date_only", date: "2026-10-05" }, eventState: "open", ...over });
  const app = (id: string, lotteryId: string, p: string, result: ResultStatus, over: Partial<Application> = {}): Application => ({
    id, lotteryId, accountId: acc(p), appliedAt: null, state: "applied", result, itemResults: {}, selectedItemId: null, resultConfirmedAt: null, fulfillment: "none", createdAt: "2026-10-01T00:00:00Z", ...over,
  });
  return { d, lot, app, chainId };
}

describe("当選率（応募単位・商品単位・未確認・中止）", () => {
  const { d, lot, app } = base();
  const lotteries = [
    lot("S1", { multiMode: "single", items: [{ id: "s1i", productId: "p-a", quantity: 1, unit: "box" }] }),
    lot("M1", {
      multiMode: "all",
      items: [
        { id: "m1a", productId: "p-a", quantity: 1, unit: "box" },
        { id: "m1b", productId: "p-b", quantity: 1, unit: "box" },
      ],
    }),
    lot("X1", { multiMode: "single", eventState: "cancelled", items: [{ id: "x1i", productId: "p-a", quantity: 1, unit: "box" }] }),
    lot("S2", { multiMode: "single", applyDeadline: { precision: "date_only", date: "2026-09-10" }, items: [{ id: "s2i", productId: "p-a", quantity: 1, unit: "box" }] }),
  ];
  const applications = [
    app("a1", "S1", "pA", "won"),
    app("a2", "S1", "pB", "lost"),
    app("a3", "S1", "pC", "pending"),
    // 複数商品: Aは2商品とも当選（応募は1件）、Bは1商品当選・1商品落選
    app("a4", "M1", "pA", "won", { itemResults: { m1a: "won", m1b: "won" } }),
    app("a5", "M1", "pB", "won", { itemResults: { m1a: "won", m1b: "lost" } }),
    // 中止になった抽選・取り消した応募は当選率の母数に入れない
    app("a6", "X1", "pA", "pending"),
    app("a7", "S1", "pA", "won", { state: "cancelled" }),
    app("a8", "S2", "pA", "lost"),
  ];
  const data: AppData = { ...d, lotteries, applications };
  const all = { period: { kind: "all" as const, value: "" }, profileId: "all" };

  it("全体: 応募は取り消しを除き、確定(当選+落選)だけが当選率の母数。未確認・中止は別に数える", () => {
    const o = computeWinStats(data, all).overall;
    expect(o.applied).toBe(7); // a7(取消)は除く
    expect([o.won, o.lost, o.pending, o.cancelled]).toEqual([3, 2, 1, 1]);
    expect(o.decided).toBe(5);
    expect(o.rate).toBeCloseTo(3 / 5);
    expect(o.lowSample).toBe(false); // 確定5件以上
    expect(formatRate(o)).toBe("60%");
  });

  it("複数商品: 1回の応募で2商品当選しても応募単位では1件。商品単位は別に数える", () => {
    const s = computeWinStats(data, all);
    expect(s.multiApplicationLevel).toMatchObject({ applied: 2, won: 2, decided: 2, rate: 1 }); // a4,a5 とも「当選」1件
    expect(s.multiItemLevel).toMatchObject({ applied: 4, won: 3, lost: 1, decided: 4 });
    // 全体の当選数は応募単位（a4の2商品当選を2件にしない）
    expect(s.overall.won).toBe(3);
  });

  it("商品別は商品単位。系列・店舗・ユーザー別の件数は全体と一致する", () => {
    const s = computeWinStats(data, all);
    const a = s.byProduct.find((r) => r.key === "p-a")!;
    expect(a.applied).toBe(7); // S1×3 + M1(2) + X1 + S2
    const sum = (rows: { applied: number }[]) => rows.reduce((n, r) => n + r.applied, 0);
    expect(sum(s.byChain)).toBe(s.overall.applied);
    expect(sum(s.byStore)).toBe(s.overall.applied);
    expect(sum(s.byProfile)).toBe(s.overall.applied);
  });

  it("ユーザーで絞ると、そのユーザーの応募だけを集計する", () => {
    const a = computeWinStats(data, { ...all, profileId: "pA" }).overall;
    expect(a.applied).toBe(4); // a1, a4, a6, a8
    expect([a.won, a.lost, a.cancelled]).toEqual([2, 1, 1]);
    expect(computeWinStats(data, { ...all, profileId: "pC" }).overall).toMatchObject({ applied: 1, pending: 1, decided: 0, rate: null });
  });

  it("期間は抽選の応募締切日で絞り込む（当月・年間・全期間）", () => {
    expect(computeWinStats(data, { ...all, period: { kind: "month", value: "2026-09" } }).overall.applied).toBe(1); // S2のみ
    expect(computeWinStats(data, { ...all, period: { kind: "month", value: "2026-10" } }).overall.applied).toBe(6);
    expect(computeWinStats(data, { ...all, period: { kind: "year", value: "2025" } }).overall.applied).toBe(0);
  });

  it("確定が少ない間は参考値、確定0件の率は「—」。希望商品を選ぶ方式は選んだ商品だけ数える", () => {
    const s = computeWinStats(data, { ...all, profileId: "pB" }).overall;
    expect(s.lowSample).toBe(true);
    expect(formatRate({ rate: null })).toBe("—");
    const c1 = lot("C1", { multiMode: "choose_one", items: [{ id: "c1a", productId: "p-a", quantity: 1, unit: "box" }, { id: "c1b", productId: "p-b", quantity: 1, unit: "box" }] });
    const d2: AppData = { ...d, lotteries: [c1], applications: [app("c", "C1", "pA", "won", { selectedItemId: "c1b", itemResults: { c1b: "won" } })] };
    const st = computeWinStats(d2, all);
    expect(st.multiItemLevel.applied).toBe(1);
    expect(st.byProduct.map((r) => r.key)).toEqual(["p-b"]);
  });
});

// ---------------------------------------------------------------- 購入記録
describe("購入記録の集計（収支と同じデータ・二重計上なし）", () => {
  const d = createMockData(NOW);
  const pk = (id: string, date: string, items: Purchase["items"], storeId: string | null = null): Purchase => ({
    id, applicationId: null, storeId, purchasedOn: { precision: "date_only", date }, channel: "store", source: "manual", items, note: "",
  });
  const purchases: Purchase[] = [
    pk("b1", "2026-10-03", [{ id: "i1", productId: "p-box", quantity: 2, unit: "box", amountPaid: 10800 }]),
    pk("b2", "2026-10-10", [{ id: "i2", productId: "p-box", quantity: 3, unit: "pack", amountPaid: null }]),
    pk("b3", "2026-09-20", [{ id: "i3", productId: "p-set", quantity: 1, unit: "set", amountPaid: 6000 }]),
    { ...pk("b4", "2026-10-11", [{ id: "i4", productId: null, productLabel: "自由入力商品", quantity: 1, unit: "box", amountPaid: 500 }]), purchasedOn: { precision: "unknown" } },
  ];
  const data: AppData = {
    ...d,
    purchases,
    products: [
      ...d.products,
      { id: "p-box", officialName: "BOX商品", aliases: [], code: "", packsPerBox: 30 },
      { id: "p-set", officialName: "セット商品", aliases: [], code: "", packsPerBox: null },
      { id: "p-comp", officialName: "構成商品", aliases: [], code: "", packsPerBox: null },
    ],
    productSetItems: [{ id: "ps1", setProductId: "p-set", componentProductId: "p-comp", quantity: 3 }],
  };

  it("期間で絞り込み、金額未入力は0円とみなさず件数を別に数える。日付不明は期間指定では含めない", () => {
    const oct = filterPurchases(data, { ...ALL_PURCHASES, period: { kind: "month", value: "2026-10" } });
    expect(oct.map((p) => p.id)).toEqual(["b2", "b1"]); // 新しい順。b4(日付不明)は含めない
    const s = summarize(oct);
    expect(s).toEqual({ count: 2, amount: 10800, amountUnknown: 1 });
    expect(filterPurchases(data, ALL_PURCHASES)).toHaveLength(4); // 全期間では日付不明も含む
  });

  it("商品別の累計: BOX×入数+パックでパック換算。入数が不明な商品は換算しない（推測しない）", () => {
    const t = productTotals(data, filterPurchases(data, ALL_PURCHASES));
    const box = t.find((r) => r.productId === "p-box")!;
    expect(box.direct).toEqual({ box: 2, pack: 3 });
    expect(box.packEquivalent).toBe(63); // 2×30 + 3
    expect(box.amount).toBe(10800);
    expect(box.amountUnknown).toBe(1);
    const free = t.find((r) => r.label === "自由入力商品")!;
    expect(free.packEquivalent).toBeNull(); // BOXだが入数不明
  });

  it("セット商品: 金額・数量はセット商品に計上し、構成商品へは数量(参考)のみ。金額は二重計上しない", () => {
    const t = productTotals(data, filterPurchases(data, ALL_PURCHASES));
    expect(t.find((r) => r.productId === "p-set")).toMatchObject({ amount: 6000, direct: { set: 1 } });
    const comp = t.find((r) => r.productId === "p-comp")!;
    expect(comp.viaSet).toBe(3);
    expect(comp.amount).toBe(0);
    expect(t.reduce((n, r) => n + r.amount, 0)).toBe(10800 + 6000 + 500); // 総額は購入明細の合計と一致
  });

  it("商品・店舗の絞り込みと、期間の前後移動", () => {
    expect(filterPurchases(data, { ...ALL_PURCHASES, productId: "p-set" }).map((p) => p.id)).toEqual(["b3"]);
    expect(shiftPeriod({ kind: "month", value: "2026-01" }, -1).value).toBe("2025-12");
    expect(shiftPeriod({ kind: "year", value: "2026" }, 1).value).toBe("2027");
  });
});

// ---------------------------------------------------------------- 対戦記録
describe("対戦記録", () => {
  const rec = (id: string, playedOn: string, result: BattleRecord["result"], myDeck = "デッキA", opponentDeck = "相手X", profileId: string | null = null): BattleRecord => ({
    id, playedOn, profileId, myDeck, opponent: "", opponentDeck, result, turnOrder: "", format: "", memo: "",
  });
  const list = [rec("1", "2026-10-01", "win"), rec("2", "2026-10-02", "lose"), rec("3", "2026-10-02", "win", "デッキB", "相手Y"), rec("4", "2026-10-03", "draw")];

  it("入力の検証: 対戦日・勝敗は必須、文字数・形式を制限する", () => {
    const ok = { playedOn: "2026-10-01", profileId: null, myDeck: "A", opponent: "", opponentDeck: "", result: "win", turnOrder: "", format: "", memo: "" };
    expect(battleInputSchema.safeParse(ok).success).toBe(true);
    expect(battleInputSchema.safeParse({ ...ok, playedOn: "" }).success).toBe(false);
    expect(battleInputSchema.safeParse({ ...ok, playedOn: "2026-13-40" }).success).toBe(false);
    expect(battleInputSchema.safeParse({ ...ok, result: "" }).success).toBe(false);
    expect(battleInputSchema.safeParse({ ...ok, myDeck: "x".repeat(101) }).success).toBe(false);
    expect(battleInputSchema.safeParse({ ...ok, profileId: "not-uuid" }).success).toBe(false);
    expect(battleInputSchema.safeParse({ ...ok, profileId: uuid }).success).toBe(true);
    expect(BATTLE_RESULT_LABEL.win).toBe("勝ち");
  });

  it("勝率は引き分けを除いた勝敗で計算。0件のときは null", () => {
    const t = tally(list);
    expect(t).toMatchObject({ total: 4, win: 2, lose: 1, draw: 1, decided: 3 });
    expect(t.winRate).toBeCloseTo(2 / 3);
    expect(tally([rec("d", "2026-10-01", "draw")]).winRate).toBeNull();
  });

  it("使用デッキ別・相手デッキ別の集計、絞り込み、日付の新しい順", () => {
    expect(tallyBy(list, (b) => b.myDeck)[0]).toMatchObject({ key: "デッキA", total: 3 });
    expect(filterBattles(list, { ...EMPTY_BATTLE_FILTER, myDeck: "デッキB" }).map((b) => b.id)).toEqual(["3"]);
    expect(filterBattles(list, { ...EMPTY_BATTLE_FILTER, from: "2026-10-02", to: "2026-10-02" }).map((b) => b.id)).toEqual(["2", "3"]);
    expect(sortBattles(list).map((b) => b.id)).toEqual(["4", "3", "2", "1"]);
    expect(tallyBy([rec("e", "2026-10-01", "win", "")], (b) => b.myDeck)[0].key).toBe("（未入力）");
  });
});
