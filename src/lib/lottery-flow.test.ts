import { describe, expect, it } from "vitest";
import { dateOnly } from "@/lib/datetime";
import { groupOngoing, kindOf, myApplication, needsResultConfirm, ongoingFor, resultCountdown, resultStage, wonProgress, wonSortRank } from "@/lib/lottery-flow";
import type { AppData, Application, Lottery } from "@/types/domain";

const NOW = new Date("2026-11-10T03:00:00Z"); // JST 2026-11-10 12:00
const U = { precision: "unknown" } as const;

function lot(over: Partial<Lottery> = {}): Lottery {
  return {
    id: "L", chainId: "c1", storeId: "s1", items: [{ id: "i1", productId: "p1", quantity: 1, unit: "box" }], multiMode: "single",
    applyStart: U, applyDeadline: U, resultDate: U, procedureStart: U, procedureDeadline: U, receiveMethod: "store", applyMethod: "web",
    conditionsText: "", verificationText: "", announcementMethod: "", sourceUrls: [], eventState: "open", limit: { basis: "account", maxCount: 1 },
    sourceKind: "manual", isNew: false, memo: "", createdAt: "2026-11-01T00:00:00Z", ...over,
  };
}
const app = (over: Partial<Application> = {}): Application => ({
  id: "a1", lotteryId: "L", accountId: "acc1", appliedAt: null, state: "applied", result: "pending", itemResults: {}, selectedItemId: null, resultConfirmedAt: null, fulfillment: "none", createdAt: "", ...over,
});

describe("当落発表の状況", () => {
  it("発表日不明ではカウントダウンを出さない", () => {
    expect(resultStage(lot(), NOW)).toBe("unknown");
    expect(resultCountdown(lot(), NOW)).toBeNull();
    expect(needsResultConfirm(lot(), NOW)).toBe(false);
  });
  it("発表前は残り日数、確認ダイアログが必要", () => {
    const l = lot({ resultDate: dateOnly("2026-11-13") });
    expect(resultStage(l, NOW)).toBe("before");
    expect(resultCountdown(l, NOW)).toEqual({ label: "あと3日", tone: "normal" });
    expect(needsResultConfirm(l, NOW)).toBe(true);
  });
  it("発表期間中・発表日当日は『発表期間中』、期間を過ぎれば『結果未確認』", () => {
    expect(resultStage(lot({ resultDate: dateOnly("2026-11-10") }), NOW)).toBe("in_period");
    expect(resultCountdown(lot({ resultDate: dateOnly("2026-11-08"), resultEndDate: "2026-11-12" }), NOW)?.label).toBe("発表期間中");
    expect(resultCountdown(lot({ resultDate: dateOnly("2026-11-05") }), NOW)).toEqual({ label: "結果未確認", tone: "danger" });
    expect(needsResultConfirm(lot({ resultDate: dateOnly("2026-11-05") }), NOW)).toBe(false);
  });
});

describe("当選後の購入・受取", () => {
  it("通常（分離なし）は『受取を記録』だけ。購入・受取の共通期限を出す", () => {
    const p = wonProgress(lot({ procedureStart: dateOnly("2026-11-08"), procedureDeadline: dateOnly("2026-11-20") }), app({ result: "won" }), NOW);
    expect(p).toMatchObject({ stage: "receive", action: "receive", status: "open", swipeable: true });
    expect(p.label).toContain("11/20");
  });
  it("分離: 購入前は購入期限、購入手続き済みなら受取期限に切り替わる", () => {
    const l = lot({ procedureSplit: true, procedureDeadline: dateOnly("2026-11-12"), receiveStart: dateOnly("2026-11-15"), receiveDeadline: dateOnly("2026-11-25") });
    const before = wonProgress(l, app({ result: "won" }), NOW);
    expect(before).toMatchObject({ stage: "purchase", action: "purchase", status: "open", label: "購入期限 11/12" });
    const bought = wonProgress(l, app({ result: "won", fulfillment: "procedure_done" }), NOW);
    expect(bought).toMatchObject({ stage: "receive", action: "receive", status: "waiting_start", swipeable: false });
    expect(bought.label).toBe("11/15から受取");
    const inWindow = wonProgress({ ...l, receiveStart: dateOnly("2026-11-09") }, app({ result: "won", fulfillment: "procedure_done" }), NOW);
    expect(inWindow).toMatchObject({ status: "open", swipeable: true });
    expect(inWindow.label).toBe("受取可能 〜11/25");
  });
  it("期限超過は要確認、受取済みは完了、期限が不明なら推測しない", () => {
    expect(wonProgress(lot({ procedureDeadline: dateOnly("2026-11-09") }), app({ result: "won" }), NOW)).toMatchObject({ status: "overdue", label: "要確認（期限超過）" });
    expect(wonProgress(lot(), app({ result: "won", fulfillment: "purchased" }), NOW)).toMatchObject({ status: "done", action: null, label: "完了" });
    expect(wonProgress(lot(), app({ result: "won" }), NOW)).toMatchObject({ status: "unknown", label: "受取期限未確認" });
  });
  it("並び: 期限超過 → 期限あり → 未確認 → 完了", () => {
    const ranks = ["overdue", "open", "unknown", "done"].map((status) => wonSortRank({ status } as never));
    expect(ranks).toEqual([0, 1, 3, 4]);
  });
});

describe("継続抽選・招待制販売", () => {
  const data = {
    accounts: [{ id: "acc1", profileId: "p1", chainId: "c1" }, { id: "acc2", profileId: "p2", chainId: "c1" }],
    lotteries: [
      lot({ id: "N", kind: "normal" }),
      lot({ id: "A1", kind: "invite", chainId: "amazon", items: [{ id: "x", productId: "p1", quantity: 1, unit: "box" }] }),
      lot({ id: "A2", kind: "invite", chainId: "amazon", items: [{ id: "y", productId: "p2", quantity: 1, unit: "box" }] }),
      lot({ id: "NJ", kind: "ongoing", chainId: "nojima", multiMode: "all", items: [1, 2, 3].map((n) => ({ id: `n${n}`, productId: `q${n}`, quantity: 1, unit: "box" as const })) }),
      lot({ id: "A3", kind: "invite", chainId: "amazon" }),
    ],
    applications: [
      app({ id: "1", lotteryId: "N", accountId: "acc1" }),
      app({ id: "2", lotteryId: "A1", accountId: "acc1" }),
      app({ id: "3", lotteryId: "A2", accountId: "acc1" }),
      app({ id: "4", lotteryId: "NJ", accountId: "acc1" }),
      app({ id: "5", lotteryId: "A3", accountId: "acc1", result: "won" }), // 招待到着 → 当選扱い（継続中から外れる）
      app({ id: "6", lotteryId: "A1", accountId: "acc2" }),
    ],
  } as unknown as AppData;

  it("通常抽選は含めず、現在のプロフィールの結果待ちだけを継続中として数える", () => {
    expect(kindOf(lot())).toBe("normal");
    expect(ongoingFor(data, "p1").map((l) => l.id).sort()).toEqual(["A1", "A2", "NJ"]);
    expect(ongoingFor(data, "p2").map((l) => l.id)).toEqual(["A1"]);
    expect(myApplication(data, "A1", "p2")?.id).toBe("6");
  });
  it("系列単位に整理し、招待は商品ごと・継続は複数商品を1行にまとめる", () => {
    const groups = groupOngoing(data, "p1", (id) => `商品${id}`);
    const amazon = groups.find((g) => g.chainId === "amazon")!;
    expect(amazon.rows.map((r) => `${r.label}|${r.state}`)).toEqual(["商品p1|招待待ち", "商品p2|招待待ち"]);
    const nojima = groups.find((g) => g.chainId === "nojima")!;
    expect(nojima.rows).toHaveLength(1);
    expect(nojima.rows[0]).toMatchObject({ label: "対象商品3件", state: "抽選継続中" });
  });
});
