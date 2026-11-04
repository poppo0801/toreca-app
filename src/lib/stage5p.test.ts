import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { dateOnly, dateTime, formatFlexMdW, formatFlexMdWTime, formatPeriodMdW, formatResultMdW, weekdayJa } from "@/lib/datetime";
import { accountsForLottery, profileSeesChainId } from "@/lib/eligibility";
import { suggestedAmount } from "@/lib/finance";
import { displayPeriod, hasSeparateSteps, ongoingFor, resultDayText, wonProgress } from "@/lib/lottery-flow";
import { profileMarks } from "@/lib/lottery-summary";
import { defaultFiltersFor, selectLotteries } from "@/lib/lottery-view";
import { planNotifications, computeAlerts, tabDots } from "@/lib/notifications";
import { profileSeesChain, scopeChainIds } from "@/lib/profile-scope";
import { expenseItemSchema } from "@/lib/finance-input";
import { manualPurchaseSchema } from "@/lib/purchase-input";
import type { AppData, Lottery, Profile } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
const U = { precision: "unknown" } as const;

describe("曜日つきの日付（日本時間の暦日から計算。固定値を使わない）", () => {
  it("曜日は日付から計算される", () => {
    expect(weekdayJa("2026-11-03")).toBe("火");
    expect(weekdayJa("2026-11-04")).toBe("水");
    expect(weekdayJa("2026-11-08")).toBe("日");
    expect(weekdayJa("2027-01-01")).toBe("金");
  });
  it("日時は日本時間の日付で曜日を決める（UTCでは前日でも、日本時間で見る）", () => {
    // 2026-11-03T16:00Z = 日本時間 2026-11-04 01:00(水)
    expect(formatFlexMdW(dateTime("2026-11-03T16:00:00Z"), NOW)).toBe("11/4(水)");
    expect(formatFlexMdWTime(dateTime("2026-11-06T14:59:00Z"), NOW)).toBe("11/6(金) 23:59");
    expect(formatFlexMdWTime(dateOnly("2026-11-06"), NOW)).toBe("11/6(金)"); // 時刻を補わない
    expect(formatFlexMdW(U, NOW)).toBeNull();
  });
  it("期間: 同日は1日、片方だけなら片側、両方不明は null", () => {
    expect(formatPeriodMdW(dateOnly("2026-11-04"), dateOnly("2026-11-06"), NOW)).toBe("11/4(水)〜11/6(金)");
    expect(formatPeriodMdW(dateOnly("2026-11-04"), dateOnly("2026-11-04"), NOW)).toBe("11/4(水)");
    expect(formatPeriodMdW(U, dateOnly("2026-11-06"), NOW)).toBe("〜11/6(金)");
    expect(formatPeriodMdW(dateOnly("2026-11-04"), U, NOW)).toBe("11/4(水)〜");
    expect(formatPeriodMdW(U, U, NOW)).toBeNull();
  });
  it("発表日（期間つき）。不明は「発表日未確認」", () => {
    expect(resultDayText({ resultDate: dateOnly("2026-11-03") }, NOW)).toBe("11/3(火)");
    expect(resultDayText({ resultDate: dateOnly("2026-11-03"), resultEndDate: "2026-11-05" }, NOW)).toBe("11/3(火)〜11/5(木)");
    expect(resultDayText({ resultDate: U }, NOW)).toBe("発表日未確認");
    expect(formatResultMdW({ resultDate: U }, NOW)).toBeNull();
  });
});

describe("応募済みカードの右側の期間（購入期間／分離していれば受取期間。応募締切で代用しない）", () => {
  const base = { procedureSplit: false, procedureStart: dateOnly("2026-11-04"), procedureDeadline: dateOnly("2026-11-06"), receiveStart: undefined, receiveDeadline: undefined } as const;
  it("通常は購入期間", () => {
    expect(displayPeriod(base, NOW)).toEqual({ label: "購入", text: "11/4(水)〜11/6(金)" });
  });
  it("購入・受取が分離している抽選は受取期間", () => {
    expect(displayPeriod({ ...base, procedureSplit: true, receiveStart: dateOnly("2026-11-05"), receiveDeadline: dateOnly("2026-11-08") }, NOW)).toEqual({ label: "受取", text: "11/5(木)〜11/8(日)" });
  });
  it("未設定は null（呼び出し側で「未定」）。分離で受取期間が未設定でも購入期間を代用しない", () => {
    expect(displayPeriod({ ...base, procedureStart: U, procedureDeadline: U }, NOW).text).toBeNull();
    expect(displayPeriod({ ...base, procedureSplit: true }, NOW)).toEqual({ label: "受取", text: null });
  });
});

describe("通販・発送の購入／受取（別々に記録・購入記録は応募ごとに1件）", () => {
  const lot = (over: Partial<Lottery> = {}): Lottery => ({
    id: "L", chainId: "c1", storeId: "s1", items: [{ id: "i1", productId: "p1", quantity: 1, unit: "box" }], multiMode: "single",
    applyStart: U, applyDeadline: U, resultDate: U, procedureStart: U, procedureDeadline: dateOnly("2026-11-20"), receiveMethod: "shipping", applyMethod: "web",
    conditionsText: "", verificationText: "", announcementMethod: "", sourceUrls: [], eventState: "open", limit: { basis: "account", maxCount: 1 },
    sourceKind: "manual", isNew: false, memo: "", createdAt: "2026-11-01T00:00:00Z", ...over,
  });
  const app = (fulfillment: "none" | "procedure_done" | "purchased") => ({ fulfillment });
  it("通販は期間を分けていなくても、購入→受取の別々の手順になる。店頭は従来どおり", () => {
    expect(hasSeparateSteps(lot())).toBe(true);
    expect(hasSeparateSteps(lot({ receiveMethod: "store" }))).toBe(false);
    expect(hasSeparateSteps(lot({ receiveMethod: "store", procedureSplit: true }))).toBe(true);
  });
  it("購入前は購入期限、購入後は「受取待ち（発送）」（購入の期限を受取の期限にしない）、受取後は完了", () => {
    expect(wonProgress(lot(), app("none"), NOW)).toMatchObject({ stage: "purchase", action: "purchase", label: "購入期限 11/20(金)" });
    expect(wonProgress(lot(), app("procedure_done"), NOW)).toMatchObject({ stage: "receive", action: "receive", status: "open", label: "受取待ち（発送）" });
    expect(wonProgress(lot(), app("purchased"), NOW)).toMatchObject({ stage: "done", status: "done" });
  });
  it("期限超過の表示は「期限超過」だけ", () => {
    expect(wonProgress(lot({ procedureDeadline: dateOnly("2026-11-01") }), app("none"), NOW).label).toBe("期限超過");
  });
});

describe("購入の数量単位「個」", () => {
  it("入力検証は個を受け付け、既存の単位（BOX・パック・セット）も維持される", () => {
    for (const unit of ["box", "pack", "set", "piece"] as const) {
      expect(expenseItemSchema.safeParse({ product: { id: null, name: "x" }, quantity: 2, unit, amountPaid: null }).success).toBe(true);
      expect(manualPurchaseSchema.safeParse({ storeId: "", date: "", time: "", channel: "store", note: "", items: [{ productId: "", quantity: 1, unit, amountPaid: null }] }).success).toBe(true);
    }
    expect(expenseItemSchema.safeParse({ product: { id: null, name: "x" }, quantity: 1, unit: "carton", amountPaid: null }).success).toBe(false);
  });
  it("定価からの仮計算: 個は単品・セットの定価、無ければ推測しない（BOX・パックは従来どおり）", () => {
    const p = { listPriceBox: 5400, listPricePack: 180, listPriceUnit: 1000 };
    expect(suggestedAmount(p, "piece", 3)).toBe(3000);
    expect(suggestedAmount(p, "box", 2)).toBe(10800);
    expect(suggestedAmount(p, "pack", 4)).toBe(720);
    expect(suggestedAmount({ ...p, listPriceUnit: null }, "piece", 1)).toBeNull();
  });
});

describe("メイン／サブユーザー", () => {
  /** A・B=メイン、C=サブ（対象系列=c1「サンプル電機」のみ）。Cのアカウントは c1・c2 の2系列にある */
  const withSub = (over: Partial<Profile> = {}): AppData => {
    const d = createMockData(NOW);
    return { ...d, profiles: d.profiles.map((p) => (p.id === "pC" ? { ...p, kind: "sub" as const, allowedChainIds: ["c1"], ...over } : { ...p, kind: "main" as const })) };
  };
  const lotteriesOf = (d: AppData, chainId: string) => d.lotteries.filter((l) => l.chainId === chainId);

  it("サブは対象系列の抽選だけ表示する。メインは全系列", () => {
    const d = withSub();
    const idsC = selectLotteries(d, "all", { ...defaultFiltersFor("all"), status: "any" }, NOW, "pC").map((l) => l.id);
    const idsA = selectLotteries(d, "all", { ...defaultFiltersFor("all"), status: "any" }, NOW, "pA").map((l) => l.id);
    expect(idsC.length).toBeGreaterThan(0);
    expect(idsC.every((id) => d.lotteries.find((l) => l.id === id)!.chainId === "c1")).toBe(true);
    expect(idsA).toHaveLength(d.lotteries.length);
  });
  it("対象系列が未設定のサブには、全系列を表示しない（何も表示しない）", () => {
    const d = withSub({ allowedChainIds: null });
    expect(selectLotteries(d, "all", { ...defaultFiltersFor("all"), status: "any" }, NOW, "pC")).toEqual([]);
    expect(profileSeesChainId(d, "pC", "c1")).toBe(false);
  });
  it("他のユーザーから見た応募状況: 対象系列のカードにだけサブのアイコンを出し、対象外の系列では未応募扱いにせずアイコン自体を出さない", () => {
    const d = withSub();
    const c1 = lotteriesOf(d, "c1")[0];
    const c2 = lotteriesOf(d, "c2")[0];
    expect(profileMarks(d, c1, NOW).map((m) => m.profileId).sort()).toEqual(["pA", "pB", "pC"]);
    expect(profileMarks(d, c2, NOW).map((m) => m.profileId).sort()).toEqual(["pA", "pB"]);
    // メインのままなら、C は c2 にも（対象外として）表示される（従来の動作）
    const main = withSub({ kind: "main" });
    expect(profileMarks(main, c2, NOW).map((m) => m.profileId)).toContain("pC");
    expect(accountsForLottery(d, c2).some((a) => a.profileId === "pC")).toBe(false);
  });
  it("サブの種別・対象系列を変えても応募・当落の履歴（データ）はそのまま残る", () => {
    const d = withSub();
    const asMain = { ...d, profiles: d.profiles.map((p) => (p.id === "pC" ? { ...p, kind: "main" as const, allowedChainIds: null } : p)) };
    expect(asMain.applications).toEqual(d.applications);
    expect(asMain.lotteries).toEqual(d.lotteries);
  });
  it("系列の別名（統合前の名前）も同じ系列として扱う", () => {
    const chains = [
      { id: "fu", name: "ふるいち", aliases: ["古本市場"] },
      { id: "old", name: "古本市場" },
      { id: "other", name: "別の系列" },
    ];
    expect([...scopeChainIds(["fu"], chains)].sort()).toEqual(["fu", "old"]);
    expect(profileSeesChain({ kind: "sub", allowedChainIds: ["old"] }, chains, "fu")).toBe(true);
    expect(profileSeesChain({ kind: "sub", allowedChainIds: ["fu"] }, chains, "other")).toBe(false);
    expect(profileSeesChain({ kind: "main", allowedChainIds: null }, chains, "other")).toBe(true);
    expect(profileSeesChain({ kind: "sub", allowedChainIds: [] }, chains, "fu")).toBe(false);
  });
  it("通知もサブは対象系列だけ（応募漏れ・当選後の手続き・タブの赤丸）", () => {
    const d = withSub();
    const due = planNotifications(d, {}, NOW).due.filter((n) => n.profileId === "pC");
    for (const n of due) expect(d.lotteries.find((l) => l.id === n.lotteryId)?.chainId).toBe("c1");
    const alerts = computeAlerts(d, "pC", NOW).filter((a) => a.lotteryId);
    for (const a of alerts) expect(d.lotteries.find((l) => l.id === a.lotteryId)?.chainId).toBe("c1");
    // 対象系列が未設定のサブには通知も赤丸も出ない
    const none = withSub({ allowedChainIds: null });
    expect(planNotifications(none, {}, NOW).due.filter((n) => n.profileId === "pC")).toEqual([]);
    expect(computeAlerts(none, "pC", NOW).filter((a) => a.lotteryId)).toEqual([]);
    expect(tabDots(none, "pC", NOW)).toEqual({ appliedDot: false, wonDot: false });
  });
  it("継続抽選の一覧もサブは対象系列だけ", () => {
    const d = withSub();
    const target = d.lotteries.find((l) => l.chainId === "c2")!;
    const dd: AppData = { ...d, lotteries: d.lotteries.map((l) => (l.id === target.id ? { ...l, kind: "ongoing" as const } : l)) };
    expect(ongoingFor(dd, "pC").some((l) => l.chainId !== "c1")).toBe(false);
  });
});
