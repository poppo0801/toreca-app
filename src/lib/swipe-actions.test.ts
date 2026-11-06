import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { dateOnly, jstDateString } from "@/lib/datetime";
import * as m from "@/lib/mutations";
import { leavesTabOnCommit, opFor, planSwipe, SWIPE_MAP, SWIPE_OPS_ENABLED } from "@/lib/swipe-actions";
import type { AppData, Lottery } from "@/types/domain";

const NOW = new Date("2026-10-26T03:00:00Z"); // JST 12:00
const data = createMockData(NOW);
const lot = (d: AppData, id: string) => d.lotteries.find((l) => l.id === id)!;
const day = (n: number) => dateOnly(jstDateString(new Date(NOW.getTime() + n * 86400_000)));

describe("スワイプの割り当て", () => {
  it("タブごとの右/左の操作が仕様どおり（当選タブの左は操作なし）", () => {
    expect(SWIPE_MAP).toEqual({
      all: { right: "add_managed", left: "skip_once" },
      managed: { right: "mark_applied", left: "unmanage" },
      applied: { right: "result_won", left: "result_lost" },
      won: { right: "receive" },
    });
    expect(opFor("won", "left")).toBeNull();
  });
  it("操作ごとに無効化できる（無効な操作は何も起きない）", () => {
    const off = { ...SWIPE_OPS_ENABLED, skip_once: false };
    expect(opFor("all", "left", off)).toBeNull();
    expect(planSwipe(data, lot(data, "L4"), "all", "left", "pA", NOW, off)).toEqual({ kind: "none" });
    expect(opFor("all", "right", off)).toBe("add_managed");
  });
});

describe("全情報タブ", () => {
  it("右: 管理対象外なら追加できる。すでに管理対象なら何もしない（通知のみ）", () => {
    const unmanaged = m.setManaged(data, "pA", "L4", false, NOW);
    expect(planSwipe(unmanaged, lot(unmanaged, "L4"), "all", "right", "pA", NOW)).toEqual({ kind: "run", op: "add_managed" });
    const again = m.setManaged(unmanaged, "pA", "L4", true, NOW);
    expect(planSwipe(again, lot(again, "L4"), "all", "right", "pA", NOW)).toMatchObject({ kind: "blocked" });
  });
  it("左: 今回のみスルー。すでにスルー中なら何もしない", () => {
    expect(planSwipe(data, lot(data, "L4"), "all", "left", "pA", NOW)).toEqual({ kind: "run", op: "skip_once" });
    const skipped = m.setLotterySkip(data, "pA", "L4", true, NOW);
    expect(planSwipe(skipped, lot(skipped, "L4"), "all", "left", "pA", NOW)).toMatchObject({ kind: "blocked" });
  });
});

describe("★管理対象タブ", () => {
  it("右: 応募済みにできる。応募済みなら何もしない", () => {
    expect(planSwipe(data, lot(data, "L4"), "managed", "right", "pA", NOW)).toEqual({ kind: "run", op: "mark_applied" });
    const applied = m.setApplied(data, "pA", "L4", "a-c3", true, NOW);
    expect(planSwipe(applied, lot(applied, "L4"), "managed", "right", "pA", NOW)).toMatchObject({ kind: "blocked", message: "すでに応募済みです" });
  });
  it("右: 希望商品を選んで応募する抽選は商品選択へ", () => {
    const d: AppData = { ...data, lotteries: data.lotteries.map((l) => (l.id === "L4" ? ({ ...l, multiMode: "choose_one" } as Lottery) : l)) };
    expect(planSwipe(d, lot(d, "L4"), "managed", "right", "pA", NOW)).toEqual({ kind: "choose-item" });
  });
  it("左: 管理対象から解除できる", () => {
    expect(planSwipe(data, lot(data, "L4"), "managed", "left", "pA", NOW)).toEqual({ kind: "run", op: "unmanage" });
  });
});

describe("応募済みタブ", () => {
  const withApp = (resultDate: Lottery["resultDate"]) => {
    const d = m.setApplied(data, "pA", "L4", "a-c3", true, NOW);
    return { ...d, lotteries: d.lotteries.map((l) => (l.id === "L4" ? { ...l, resultDate } : l)) };
  };
  it("発表前の当落は確認ダイアログ、発表後・発表日不明は確認なしで記録", () => {
    const before = withApp(day(3));
    expect(planSwipe(before, lot(before, "L4"), "applied", "right", "pA", NOW)).toEqual({ kind: "confirm", op: "result_won" });
    expect(planSwipe(before, lot(before, "L4"), "applied", "left", "pA", NOW)).toEqual({ kind: "confirm", op: "result_lost" });
    const unknown = withApp({ precision: "unknown" });
    expect(planSwipe(unknown, lot(unknown, "L4"), "applied", "right", "pA", NOW)).toEqual({ kind: "run", op: "result_won" });
    const after = withApp(day(-2));
    expect(planSwipe(after, lot(after, "L4"), "applied", "left", "pA", NOW)).toEqual({ kind: "run", op: "result_lost" });
  });
  it("応募していない・結果記録済みなら何もしない。複数商品は詳細へ", () => {
    expect(planSwipe(data, lot(data, "L4"), "applied", "right", "pA", NOW)).toMatchObject({ kind: "blocked" });
    const base = withApp(day(-1));
    const done = m.setResult(base, "pA", m_app(base, "L4"), "won", NOW);
    expect(planSwipe(done, lot(done, "L4"), "applied", "right", "pA", NOW)).toMatchObject({ kind: "blocked", message: "結果は記録済みです" });
    const multi = withApp(day(-1));
    const md: AppData = { ...multi, lotteries: multi.lotteries.map((l) => (l.id === "L4" ? ({ ...l, multiMode: "all" } as Lottery) : l)) };
    expect(planSwipe(md, lot(md, "L4"), "applied", "right", "pA", NOW)).toMatchObject({ kind: "open-detail" });
  });
});
function m_app(d: AppData, lotteryId: string) {
  return d.applications.find((a) => a.lotteryId === lotteryId && a.accountId === "a-c3")!.id;
}

describe("当選タブ", () => {
  const withL7 = (patch: Partial<Lottery>): AppData => ({ ...data, lotteries: data.lotteries.map((l) => (l.id === "L7" ? { ...l, ...patch } : l)) });
  it("通常（分離なし）は受取済みへ。左スワイプは操作なし", () => {
    const d = withL7({ procedureStart: day(-1), procedureDeadline: day(5) });
    expect(planSwipe(d, lot(d, "L7"), "won", "right", "pA", NOW)).toEqual({ kind: "run", op: "receive" });
    expect(planSwipe(d, lot(d, "L7"), "won", "left", "pA", NOW)).toEqual({ kind: "none" });
  });
  it("購入と受取が分かれている場合は選択ダイアログ（Undoなし）", () => {
    const d = withL7({ procedureSplit: true, procedureDeadline: day(3), receiveStart: day(5), receiveDeadline: day(9) });
    expect(planSwipe(d, lot(d, "L7"), "won", "right", "pA", NOW)).toEqual({ kind: "choose-fulfillment" });
  });
  it("期間前は無効（スワイプしても記録しない）。他のユーザーが当選のみ・受取済みも何もしない", () => {
    const d = withL7({ procedureStart: day(2), procedureDeadline: day(9) });
    expect(planSwipe(d, lot(d, "L7"), "won", "right", "pA", NOW)).toMatchObject({ kind: "blocked" });
    expect(planSwipe(d, lot(d, "L7"), "won", "right", "pB", NOW)).toMatchObject({ kind: "blocked", message: "このユーザーは当選していません" });
    const done = m.setFulfillment(withL7({ procedureDeadline: day(9) }), "pA", d.applications.find((a) => a.lotteryId === "L7")!.id, "purchased", NOW);
    expect(planSwipe(done, lot(done, "L7"), "won", "right", "pA", NOW)).toMatchObject({ kind: "blocked", message: "すでに受取済みです" });
  });
});

describe("leavesTabOnCommit（確定後に同じ方向へ流れて消える操作）", () => {
  it("一覧から外れる操作だけ true。応募済み（専用の退場）・★追加は false", () => {
    expect(leavesTabOnCommit("unmanage", "managed")).toBe(true);
    expect(leavesTabOnCommit("skip_once", "all")).toBe(true);
    expect(leavesTabOnCommit("result_won", "applied")).toBe(true);
    expect(leavesTabOnCommit("result_lost", "applied")).toBe(true);
    expect(leavesTabOnCommit("receive", "won")).toBe(true);
    expect(leavesTabOnCommit("mark_applied", "managed")).toBe(true); // 要チェック → 応募済み（タブが変わる）
    expect(leavesTabOnCommit("add_managed", "all")).toBe(true); // 全情報 → 要チェック（Stage 6L: 同じ抽選は1つのタブにだけ出る）
  });
});
