import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { recentStoreCandidates, selectStoreDisplay } from "@/lib/applied-store";
import { dateOnly, jstDateString, UNKNOWN_DATE } from "@/lib/datetime";
import { wonNeedsAction } from "@/lib/lottery-flow";
import { DEFAULT_FILTERS, hasActiveWon, selectLotteries, tabOf } from "@/lib/lottery-view";
import { tabDots } from "@/lib/notifications";
import { normalizeProfileSettings, SETTING_KEYS } from "@/lib/profile-settings";
import { adjacentTab, startsAtEdge, tabSwipeDirection } from "@/lib/tab-swipe";
import type { AppData, Application, Lottery } from "@/types/domain";

const NOW = new Date("2026-11-08T03:00:00Z");
const day = (n: number) => dateOnly(jstDateString(new Date(NOW.getTime() + n * 86_400_000)));

describe("Stage 7B: 応募店舗の候補", () => {
  // 系列 c1 の店舗選択式の抽選に、プロフィールA・Bが別々の店舗で応募した履歴
  const mk = (): AppData => {
    const d = createMockData(NOW);
    const sel = (id: string): Lottery => ({ ...d.lotteries.find((l) => l.id === "L1")!, id, chainId: "c1", storeMode: "select_on_apply" });
    const lots = [sel("S1"), sel("S2"), sel("S3")];
    const app = (id: string, lotteryId: string, accountId: string, name: string, at: string): Application => ({
      id,
      lotteryId,
      accountId,
      appliedAt: at,
      state: "applied",
      result: "pending",
      itemResults: {},
      selectedItemId: null,
      appliedStore: { id: null, name, prefecture: "" },
      resultConfirmedAt: null,
      fulfillment: "none",
      createdAt: at,
    });
    return {
      ...d,
      lotteries: [...d.lotteries, ...lots],
      applications: [
        ...d.applications,
        app("x1", "S1", "a-c1", "GEO 神戸店", "2026-10-01T00:00:00Z"),
        app("x2", "S2", "a-c1", "GEO 神戸店", "2026-10-10T00:00:00Z"),
        app("x3", "S2", "b-c1", "GEO 三宮店", "2026-10-11T00:00:00Z"),
      ],
    };
  };
  it("現在のプロフィールの履歴を先頭に、利用回数の多い順。同じ店舗名は1つ。他のプロフィールの店舗は出さない", () => {
    const d = mk();
    const a = recentStoreCandidates(d, d.lotteries.find((l) => l.id === "S3")!, "pA");
    expect(a[0]).toMatchObject({ name: "GEO 神戸店", history: true, uses: 2 });
    expect(a.map((c) => c.name)).not.toContain("GEO 三宮店");
    expect(new Set(a.map((c) => c.name)).size).toBe(a.length);
    const b = recentStoreCandidates(d, d.lotteries.find((l) => l.id === "S3")!, "pB");
    expect(b[0]).toMatchObject({ name: "GEO 三宮店", history: true });
    expect(b.map((c) => c.name)).not.toContain("GEO 神戸店");
  });
  it("履歴が無ければ系列マスターの店舗。別の系列の店舗は候補に出さない", () => {
    const d = mk();
    const l = d.lotteries.find((x) => x.id === "S3")!;
    const c = recentStoreCandidates(d, l, "pC-none");
    expect(c.every((x) => !x.history)).toBe(true);
    const chainStores = d.stores.filter((s) => s.chainId === "c1").map((s) => s.name);
    expect(c.map((x) => x.name).sort()).toEqual(chainStores.sort());
  });
  it("別の系列の抽選で記録された店舗名は、この系列の店舗マスターに無ければ候補にしない", () => {
    const d = mk();
    const other = d.lotteries.find((x) => x.chainId === "c2")!;
    d.applications = [
      ...d.applications,
      { id: "z", lotteryId: other.id, accountId: "a-c1", appliedAt: "2026-10-20T00:00:00Z", state: "applied", result: "pending", itemResults: {}, selectedItemId: null, appliedStore: { id: null, name: "別系列の店", prefecture: "" }, resultConfirmedAt: null, fulfillment: "none", createdAt: "2026-10-20T00:00:00Z" },
    ];
    const c = recentStoreCandidates(d, d.lotteries.find((x) => x.id === "S3")!, "pA");
    expect(c.map((x) => x.name)).not.toContain("別系列の店");
  });
  it("カードの店舗表示: 応募前は「店舗選択式」、応募後は現在のプロフィールの店舗（AとBで別）。店舗固定の抽選は対象外", () => {
    const d = mk();
    const s2 = d.lotteries.find((l) => l.id === "S2")!;
    const s3 = d.lotteries.find((l) => l.id === "S3")!;
    expect(selectStoreDisplay(d, s3, "pA")?.text).toBe("店舗選択式");
    expect(selectStoreDisplay(d, s2, "pA")?.text).toBe("GEO 神戸店");
    expect(selectStoreDisplay(d, s2, "pB")?.text).toBe("GEO 三宮店");
    // 表示範囲に両方いるときも1つの表示にまとめ、全員分は title で確認できる
    const both = selectStoreDisplay(d, s2, "pA", new Set(["pA", "pB"]))!;
    expect(both.text).toBe("GEO 神戸店");
    expect(both.title).toContain("GEO 三宮店");
    expect(selectStoreDisplay(d, d.lotteries.find((l) => l.id === "L1")!, "pA")).toBeNull();
  });
});

describe("Stage 7B: 当選タブ", () => {
  const withWon = (patch: Partial<Lottery>, fulfillment: Application["fulfillment"] = "none"): AppData => {
    const d = createMockData(NOW);
    return {
      ...d,
      lotteries: d.lotteries.map((l) => (l.id === "L7" ? { ...l, ...patch } : l)),
      applications: d.applications.map((a) => (a.id === "ap5" ? { ...a, fulfillment } : a)),
    };
  };
  it("受取済みは当選タブの一覧に出ない。当選・受取の記録は残る", () => {
    const d = withWon({}, "purchased");
    expect(selectLotteries(d, "won", DEFAULT_FILTERS, NOW).map((l) => l.id)).not.toContain("L7");
    expect(hasActiveWon(d, "L7")).toBe(false);
    expect(d.applications.find((a) => a.id === "ap5")).toMatchObject({ result: "won", fulfillment: "purchased" });
    expect(tabOf(d, d.lotteries.find((l) => l.id === "L7")!)).not.toBe("won");
  });
  it("●: 購入/受取の期間中の未対応・期限超過の未処理だけ。開始前・完了・期間未設定は出さない", () => {
    const dot = (patch: Partial<Lottery>, f: Application["fulfillment"] = "none") => tabDots(withWon(patch, f), "pA", NOW).wonDot;
    expect(dot({ procedureStart: day(-1), procedureDeadline: day(5) })).toBe(true); // 受取期間中（共通の期間）
    expect(dot({ procedureStart: day(-10), procedureDeadline: day(-2) })).toBe(true); // 期限超過でも未処理なら出す
    expect(dot({ procedureStart: day(3), procedureDeadline: day(9) })).toBe(false); // 期間の開始前は対応不要
    expect(dot({ procedureStart: UNKNOWN_DATE, procedureDeadline: UNKNOWN_DATE })).toBe(false); // 期間が未設定: 対応が必要と確実に言えない
    expect(dot({ procedureStart: day(-1), procedureDeadline: UNKNOWN_DATE })).toBe(true); // 始まっていて期限が未確認
    expect(dot({ procedureStart: day(-1), procedureDeadline: day(5) }, "purchased")).toBe(false); // 完了
  });
  it("購入と受取が分かれている抽選: 購入期間中の未購入、受取期間中の未受取で出る。受取期間の開始前は出ない", () => {
    const split: Partial<Lottery> = { procedureSplit: true, procedureStart: day(-2), procedureDeadline: day(4), receiveStart: day(6), receiveDeadline: day(12) };
    const l = (d: AppData) => d.lotteries.find((x) => x.id === "L7")!;
    const app = (d: AppData, f: Application["fulfillment"]) => ({ ...d.applications.find((a) => a.id === "ap5")!, fulfillment: f });
    const d = withWon(split);
    expect(wonNeedsAction(l(d), app(d, "none"), NOW)).toBe(true); // 購入期間中の未購入
    expect(wonNeedsAction(l(d), app(d, "procedure_done"), NOW)).toBe(false); // 購入済み・受取期間の開始前
    const d2 = withWon({ ...split, receiveStart: day(-1), receiveDeadline: day(5) });
    expect(wonNeedsAction(l(d2), app(d2, "procedure_done"), NOW)).toBe(true); // 受取期間中の未受取
  });
  it("プロフィールの絞り込み（表示範囲）に従って判定される", () => {
    const d = withWon({ procedureStart: day(-1), procedureDeadline: day(5) });
    expect(tabDots(d, "pA", NOW, new Set(["pA"])).wonDot).toBe(true);
    expect(tabDots(d, "pA", NOW, new Set(["pB"])).wonDot).toBe(false); // 当選しているのは pA の応募
    expect(tabDots(d, "pB", NOW, new Set(["pA", "pB"])).wonDot).toBe(true);
  });
});

describe("Stage 7B: タブ切替スワイプの判定", () => {
  const order = ["all", "managed", "applied", "won"] as const;
  it("左スワイプ=次のタブ、右スワイプ=前のタブ。端ではそれ以上動かない", () => {
    expect(adjacentTab(order, "managed", "next")).toBe("applied");
    expect(adjacentTab(order, "managed", "prev")).toBe("all");
    expect(adjacentTab(order, "all", "prev")).toBeNull();
    expect(adjacentTab(order, "won", "next")).toBeNull();
    expect(tabSwipeDirection(-120, 8, 390, 200)).toBe("next");
    expect(tabSwipeDirection(120, -8, 390, 200)).toBe("prev");
  });
  it("縦スクロール・移動量不足・ゆっくりした操作・画面の端からの操作では切り替えない", () => {
    expect(tabSwipeDirection(-80, 120, 390, 200)).toBeNull(); // 縦が主
    expect(tabSwipeDirection(-30, 2, 390, 200)).toBeNull(); // 足りない
    expect(tabSwipeDirection(-150, 4, 390, 1500)).toBeNull(); // 長押しからの移動など
    expect(startsAtEdge(10, 390)).toBe(true); // iOSの戻るジェスチャー
    expect(startsAtEdge(380, 390)).toBe(true);
    expect(startsAtEdge(200, 390)).toBe(false);
  });
});

describe("Stage 7B: プロフィール別の設定", () => {
  it("スワイプ操作・日付表示を検証して保存対象にする。未設定は既定（カード操作／Aタイプ）のまま", () => {
    expect(normalizeProfileSettings({ swipeMode: "tab", dateLayout: "b" })).toEqual({ swipeMode: "tab", dateLayout: "b" });
    expect(normalizeProfileSettings({ swipeMode: "x", dateLayout: 3 })).toEqual({});
    expect(normalizeProfileSettings({})).toEqual({});
    expect(SETTING_KEYS).toEqual(expect.arrayContaining(["swipeMode", "dateLayout"]));
  });
});
