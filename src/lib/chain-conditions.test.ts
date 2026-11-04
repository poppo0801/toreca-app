import { describe, expect, it } from "vitest";
import {
  addDays,
  evaluateChain,
  evaluateLottery,
  evaluatePurchase,
  needsReconfirm,
  purchaseFacts,
  purchaseWindow,
  remainingFromDays,
  remainingLabel,
  sanitizePurchaseParams,
  type ChainCondition,
  type PurchaseFact,
} from "@/lib/chain-conditions";
import { createMockData } from "@/data/mock";
import type { AppData } from "@/types/domain";

const CHAIN = "c1";
const A = "pA";
const B = "pB";
const fact = (date: string | null, amount: number | null, over: Partial<PurchaseFact> = {}): PurchaseFact => ({
  id: `f${Math.random()}`, date, amount: amount ?? 0, amountKnown: amount !== null, chainId: CHAIN, storeId: null, buyerProfileId: A, ...over,
});
const ctx = (startDate: string, over: object = {}) => ({ chainId: CHAIN, profileId: A, startDate, ...over });

describe("purchaseWindow（日付境界）", () => {
  it("開始日2026/11/10・3日前・過去365日 → 2025/11/7〜2026/11/7（両端を含む）", () => {
    expect(purchaseWindow("2026-11-10", { baseDaysBefore: 3, windowDays: 365 })).toEqual({ from: "2025-11-07", to: "2026-11-07" });
  });
  it("基準日が開始日当日・期間未設定は null", () => {
    expect(purchaseWindow("2026-11-10", { baseDaysBefore: 0, windowDays: 30 })).toEqual({ from: "2026-10-11", to: "2026-11-10" });
    expect(purchaseWindow("2026-11-10", { baseDaysBefore: 0 })).toBeNull();
  });
  it("境界日の購入は対象に含まれ、1日前は含まれない", () => {
    const p = { baseDaysBefore: 3, windowDays: 365 };
    expect(evaluatePurchase([fact("2025-11-07", 1000)], p, ctx("2026-11-10")).state).toBe("met");
    expect(evaluatePurchase([fact("2025-11-06", 1000)], p, ctx("2026-11-10")).state).toBe("unmet");
    expect(evaluatePurchase([fact("2026-11-07", 1000)], p, ctx("2026-11-10")).state).toBe("met");
    expect(evaluatePurchase([fact("2026-11-08", 1000)], p, ctx("2026-11-10")).state).toBe("unmet"); // 基準日より後
  });
});

describe("evaluatePurchase（金額・回数・複数購入の合算）", () => {
  const p = { baseDaysBefore: 0, windowDays: 365, minAmountYen: 3000, minCount: 2 };
  it("金額と回数の両方を評価する（片方だけでは達成しない）", () => {
    expect(evaluatePurchase([fact("2026-10-01", 5000)], p, ctx("2026-11-04")).state).toBe("unmet"); // 回数不足
    expect(evaluatePurchase([fact("2026-10-01", 1000), fact("2026-10-02", 1000)], p, ctx("2026-11-04")).state).toBe("unmet"); // 金額不足
    expect(evaluatePurchase([fact("2026-10-01", 1500), fact("2026-10-02", 1500)], p, ctx("2026-11-04")).state).toBe("met");
  });
  it("複数の購入履歴を合算する", () => {
    const r = evaluatePurchase([fact("2026-09-01", 2000), fact("2026-10-01", 2000)], { baseDaysBefore: 0, windowDays: 365, minAmountYen: 3000 }, ctx("2026-11-04"));
    expect(r.state).toBe("met");
    expect(r.amount).toBe(4000);
    expect(r.count).toBe(2);
  });
  it("金額・回数とも未設定なら1回以上の購入で達成", () => {
    expect(evaluatePurchase([fact("2026-10-20", 100)], { baseDaysBefore: 0, windowDays: 30 }, ctx("2026-11-04")).state).toBe("met");
    expect(evaluatePurchase([], { baseDaysBefore: 0, windowDays: 30 }, ctx("2026-11-04")).state).toBe("unmet");
  });
  it("購入金額が不明な記録だけでは金額条件を達成と判断しない（未確認）", () => {
    const r = evaluatePurchase([fact("2026-10-01", null)], { baseDaysBefore: 0, windowDays: 365, minAmountYen: 3000 }, ctx("2026-11-04"));
    expect(r.state).toBe("unknown");
    expect(r.unknownRecords).toBe(1);
  });
  it("日付が不明な記録は数えず、あれば未確認", () => {
    const r = evaluatePurchase([fact(null, 5000)], { baseDaysBefore: 0, windowDays: 365 }, ctx("2026-11-04"));
    expect(r.state).toBe("unknown");
  });
  it("他のプロフィール・他の系列の購入は混同しない", () => {
    const facts = [fact("2026-10-01", 5000, { buyerProfileId: B }), fact("2026-10-01", 5000, { chainId: "c2" })];
    expect(evaluatePurchase(facts, { baseDaysBefore: 0, windowDays: 365 }, ctx("2026-11-04")).state).toBe("unmet");
  });
  it("対象店舗を指定した場合、その店舗の購入だけを数える。店舗が不明な記録は未確認", () => {
    const sid = "11111111-1111-1111-1111-111111111111";
    const params = { baseDaysBefore: 0, windowDays: 365, storeIds: [sid] };
    expect(evaluatePurchase([fact("2026-10-01", 100, { storeId: "22222222-2222-2222-2222-222222222222" })], params, ctx("2026-11-04")).state).toBe("unmet");
    expect(evaluatePurchase([fact("2026-10-01", 100, { storeId: sid })], params, ctx("2026-11-04")).state).toBe("met");
    expect(evaluatePurchase([fact("2026-10-01", 100, { storeId: null })], params, ctx("2026-11-04")).state).toBe("unknown");
  });
  it("対象期間が未設定なら資格要確認", () => {
    const r = evaluatePurchase([fact("2026-10-01", 100)], { baseDaysBefore: 0 }, ctx("2026-11-04"));
    expect(r.state).toBe("unknown");
    expect(remainingLabel(r.remaining)).toBe("資格要確認");
  });
});

describe("資格の残り期間（月単位の目安）", () => {
  const p = { baseDaysBefore: 0, windowDays: 365 };
  it("今日から約8ヶ月後に購入が期間外になる → あと8ヶ月", () => {
    // 購入日 = 今日 − 365 + 250日 → 約250日後（8.2ヶ月）に外れる
    const today = "2026-11-04";
    const d = addDays(today, -365 + 250);
    const r = evaluatePurchase([fact(d, 1000)], p, ctx(today));
    expect(r.state).toBe("met");
    expect(remainingLabel(r.remaining)).toBe("あと8ヶ月");
  });
  it("約1ヶ月以内に外れる → まもなく資格切れ", () => {
    const today = "2026-11-04";
    const r = evaluatePurchase([fact(addDays(today, -365 + 20), 1000)], p, ctx(today));
    expect(remainingLabel(r.remaining)).toBe("まもなく資格切れ");
  });
  it("古い1件が外れても、残りの購入で条件を満たす間は資格切れとしない（最新の有効な組み合わせで計算）", () => {
    const today = "2026-11-04";
    // 条件: 3000円以上。古い購入(1000円)が先に外れても、新しい購入(3500円)だけで維持できる → 新しい購入が外れる時期で判定
    const old = fact(addDays(today, -365 + 10), 1000);
    const recent = fact(addDays(today, -365 + 300), 3500);
    const r = evaluatePurchase([old, recent], { ...p, minAmountYen: 3000 }, ctx(today));
    expect(r.state).toBe("met");
    expect(remainingLabel(r.remaining)).toBe("あと9ヶ月"); // 300日 ≈ 9.8ヶ月 → 床で9
  });
  it("合算で満たしている場合は、合算できなくなる時期（古い方が外れるとき）", () => {
    const today = "2026-11-04";
    const a = fact(addDays(today, -365 + 100), 2000);
    const b = fact(addDays(today, -365 + 300), 2000);
    const r = evaluatePurchase([a, b], { ...p, minAmountYen: 3000 }, ctx(today));
    expect(remainingLabel(r.remaining)).toBe("あと3ヶ月"); // 100日 ≈ 3.3ヶ月
  });
  it("remainingFromDays: 31日以内は まもなく、それ以降は月数", () => {
    expect(remainingFromDays(31)).toEqual({ kind: "soon" });
    expect(remainingFromDays(32)).toEqual({ kind: "months", months: 1 });
    expect(remainingFromDays(365)).toEqual({ kind: "months", months: 11 });
  });
  it("今回の抽選固有の明示的な期間で判定するときは残り期間を出さない", () => {
    const r = evaluatePurchase([fact("2026-10-01", 1000)], p, ctx("2026-11-04", { override: { from: "2026-01-01", to: "2026-12-31" } }));
    expect(r.state).toBe("met");
    expect(r.remaining.kind).toBe("none");
  });
});

describe("sanitizePurchaseParams", () => {
  it("不正な値は捨てる（推測で埋めない）", () => {
    expect(sanitizePurchaseParams({ baseDaysBefore: -1, windowDays: 0, minAmountYen: "x", minCount: 1.5, storeIds: ["bad"] })).toEqual({ baseDaysBefore: 0 });
    expect(sanitizePurchaseParams({ baseDaysBefore: 3, windowDays: 365, minAmountYen: 3000, minCount: 2 })).toEqual({ baseDaysBefore: 3, windowDays: 365, minAmountYen: 3000, minCount: 2 });
  });
});

/** データ上の条件・状態・購入を持つ最小のAppData */
function dataWith(conds: Partial<ChainCondition>[], states: { conditionId: string; profileId: string; state: "met" | "unmet" | "unknown"; confirmedOn?: string }[] = []): AppData {
  const d = createMockData(new Date("2026-11-04T00:00:00+09:00"));
  d.chainConditions = conds.map((c, i) => ({ id: `cond${i}`, chainId: CHAIN, kind: "other", label: "", params: {}, note: "", joinPrev: "and", sortOrder: i, ...c }) as ChainCondition);
  d.chainConditionStates = states.map((s, i) => ({ id: `s${i}`, confirmedOn: null, note: "", ...s }));
  return d;
}
const opts = { today: "2026-11-04" };

describe("evaluateChain（AND / OR）", () => {
  it("条件が無ければ none", () => {
    expect(evaluateChain(dataWith([]), CHAIN, A, { ...opts, facts: [] }).overall).toBe("none");
  });
  it("すべて必須（AND）: 1つでも未達成なら未達成、未確認が残れば未確認", () => {
    const d = dataWith([{ kind: "member_card" }, { kind: "line" }], [{ conditionId: "cond0", profileId: A, state: "met" }, { conditionId: "cond1", profileId: A, state: "unmet" }]);
    expect(evaluateChain(d, CHAIN, A, { ...opts, facts: [] }).overall).toBe("unmet");
    const d2 = dataWith([{ kind: "member_card" }, { kind: "line" }], [{ conditionId: "cond0", profileId: A, state: "met" }]);
    expect(evaluateChain(d2, CHAIN, A, { ...opts, facts: [] }).overall).toBe("unknown");
    const d3 = dataWith([{ kind: "member_card" }, { kind: "line" }], [{ conditionId: "cond0", profileId: A, state: "met" }, { conditionId: "cond1", profileId: A, state: "met" }]);
    expect(evaluateChain(d3, CHAIN, A, { ...opts, facts: [] }).overall).toBe("met");
  });
  it("いずれかで可（OR）: 前の条件と同じグループ。どちらか達成で達成", () => {
    const d = dataWith([{ kind: "app_account" }, { kind: "purchase", params: { baseDaysBefore: 0, windowDays: 365 }, joinPrev: "or" }], [{ conditionId: "cond0", profileId: A, state: "unmet" }]);
    const facts = [fact("2026-10-01", 1000)];
    expect(evaluateChain(d, CHAIN, A, { ...opts, facts }).overall).toBe("met");
    expect(evaluateChain(d, CHAIN, A, { ...opts, facts: [] }).overall).toBe("unmet");
  });
  it("プロフィール別: Aは達成でもBは未確認", () => {
    const d = dataWith([{ kind: "member_card" }], [{ conditionId: "cond0", profileId: A, state: "met", confirmedOn: "2026-10-01" }]);
    expect(evaluateChain(d, CHAIN, A, { ...opts, facts: [] }).overall).toBe("met");
    expect(evaluateChain(d, CHAIN, B, { ...opts, facts: [] }).overall).toBe("unknown");
  });
  it("イベント・大会・ジムバトルも手動で達成/未達成/未確認を持てる", () => {
    const d = dataWith([{ kind: "event", label: "発売記念イベント" }, { kind: "tournament" }, { kind: "gym_battle" }], [{ conditionId: "cond0", profileId: A, state: "met" }, { conditionId: "cond1", profileId: A, state: "unmet" }]);
    const r = evaluateChain(d, CHAIN, A, { ...opts, facts: [] });
    expect(r.results.map((x) => x.state)).toEqual(["met", "unmet", "unknown"]);
  });
  it("残り期間: 購入が唯一の達成要件なら残り期間を出し、手動の達成済み条件とORなら出さない", () => {
    const fa = [fact(addDays("2026-11-04", -365 + 250), 1000)];
    const p = { baseDaysBefore: 0, windowDays: 365 };
    const only = dataWith([{ kind: "purchase", params: p }]);
    expect(remainingLabel(evaluateChain(only, CHAIN, A, { ...opts, facts: fa }).remaining!)).toBe("あと8ヶ月");
    const orMember = dataWith([{ kind: "member_card" }, { kind: "purchase", params: p, joinPrev: "or" }], [{ conditionId: "cond0", profileId: A, state: "met" }]);
    expect(evaluateChain(orMember, CHAIN, A, { ...opts, facts: fa }).remaining).toBeNull();
  });
  it("購入判定は購入履歴から都度算出する（購入が取り消されれば未達成に戻る）", () => {
    const d = dataWith([{ kind: "purchase", params: { baseDaysBefore: 0, windowDays: 365 } }]);
    expect(evaluateChain(d, CHAIN, A, { ...opts, facts: [fact("2026-10-01", 1000)] }).overall).toBe("met");
    expect(evaluateChain(d, CHAIN, A, { ...opts, facts: [] }).overall).toBe("unmet");
  });
});

describe("purchaseFacts（既存の購入記録を正とする。当選だけでは購入にならない）", () => {
  it("当選・応募だけでは購入にならず、購入記録のある応募だけが購入者のプロフィールに紐づく", () => {
    const d = createMockData(new Date("2026-11-04T00:00:00+09:00"));
    const app = d.applications.find((a) => a.result === "won") ?? d.applications[0];
    const before = purchaseFacts(d).filter((f) => f.buyerProfileId && d.applications.some((x) => x.id === app.id)).length;
    d.purchases.push({ id: "pp1", applicationId: app.id, storeId: null, purchasedOn: { precision: "date_only", date: "2026-10-20" }, channel: "store", source: "lottery", note: "", items: [{ productId: null, quantity: 1, unit: "box", amountPaid: 5400 }] });
    const facts = purchaseFacts(d);
    const f = facts.find((x) => x.id === "pp1")!;
    expect(f.buyerProfileId).toBe(d.accounts.find((a) => a.id === app.accountId)?.profileId);
    expect(f.chainId).toBe(d.lotteries.find((l) => l.id === app.lotteryId)?.chainId);
    expect(f.amount).toBe(5400);
    expect(facts.length).toBe(d.purchases.length);
    expect(before).toBeGreaterThanOrEqual(0);
  });
  it("金額が一部不明なら amountKnown=false", () => {
    const d = createMockData(new Date("2026-11-04T00:00:00+09:00"));
    d.purchases = [{ id: "x", applicationId: null, storeId: null, buyerProfileId: A, purchasedOn: { precision: "unknown" }, channel: "store", source: "manual", note: "", items: [{ productId: null, quantity: 1, unit: "box", amountPaid: null }] }];
    const f = purchaseFacts(d)[0];
    expect(f.amountKnown).toBe(false);
    expect(f.date).toBeNull();
    expect(f.buyerProfileId).toBe(A);
  });
});

describe("evaluateLottery（今回の抽選との比較。登録条件は変更しない）", () => {
  const base = () => {
    const d = createMockData(new Date("2026-11-04T00:00:00+09:00"));
    const lot = d.lotteries[0];
    d.chainConditions = [{ id: "k0", chainId: lot.chainId, kind: "purchase", label: "", params: { baseDaysBefore: 0, windowDays: 365, minAmountYen: 3000 }, note: "", joinPrev: "and", sortOrder: 0 }];
    d.chainConditionStates = [];
    return { d, lot };
  };
  it("系列に条件が無ければ null（カードに何も出さない）", () => {
    const d = createMockData(new Date("2026-11-04T00:00:00+09:00"));
    expect(evaluateLottery(d, d.lotteries[0], A, "2026-11-04")).toBeNull();
  });
  it("今回の金額・期間が系列登録と異なれば相違を返す。系列条件そのものは書き換えない", () => {
    const { d, lot } = base();
    lot.requirementDetails = { minAmountYen: 5000, purchasePeriodFrom: "2026-05-08", purchasePeriodTo: "2026-11-04" };
    const before = JSON.stringify(d.chainConditions);
    const r = evaluateLottery(d, lot, A, "2026-11-04")!;
    expect(r.mismatches.length).toBe(2);
    expect(r.mismatches[0]).toContain("3,000円以上");
    expect(r.mismatches[0]).toContain("5,000円以上");
    expect(JSON.stringify(d.chainConditions)).toBe(before);
  });
  it("今回の抽選の最低金額を優先して判定する", () => {
    const { d, lot } = base();
    const a = d.accounts.find((x) => x.profileId === A) ?? d.accounts[0];
    const profileId = a.profileId;
    d.purchases.push({ id: "pz", applicationId: null, storeId: null, buyerProfileId: profileId, purchasedOn: { precision: "date_only", date: "2026-10-20" }, channel: "store", source: "manual", note: "", items: [{ productId: null, quantity: 1, unit: "box", amountPaid: 4000 }] });
    // 購入の chain が一致するよう store を付ける
    const store = d.stores.find((s) => s.chainId === lot.chainId)!;
    d.purchases[d.purchases.length - 1].storeId = store.id;
    expect(evaluateLottery(d, lot, profileId, "2026-11-04")!.overall).toBe("met");
    lot.requirementDetails = { minAmountYen: 5000 };
    expect(evaluateLottery(d, lot, profileId, "2026-11-04")!.overall).toBe("unmet");
  });
  it("告知に読み取れなかった条件は「なし」と扱わない。系列にない種類の条件がある場合だけ相違", () => {
    const { d, lot } = base();
    lot.requirementTags = [];
    expect(evaluateLottery(d, lot, A, "2026-11-04")!.mismatches).toEqual([]);
    lot.requirementTags = ["line_register"];
    expect(evaluateLottery(d, lot, A, "2026-11-04")!.mismatches[0]).toContain("LINE");
  });
});

describe("needsReconfirm", () => {
  it("確認日から180日を超えたら再確認の目安。未確認日は対象外", () => {
    expect(needsReconfirm("2026-01-01", "2026-11-04")).toBe(true);
    expect(needsReconfirm("2026-09-01", "2026-11-04")).toBe(false);
    expect(needsReconfirm(null, "2026-11-04")).toBe(false);
  });
});
