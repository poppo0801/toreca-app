import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { dateOnly, dateTime, jstDateString } from "@/lib/datetime";
import { jstAt, planNotifications } from "@/lib/notifications";
import type { AppData, FlexibleDate, Lottery } from "@/types/domain";

/** 2026-10-26 12:00 JST。L7 は A が当選済みの抽選 */
const NOW = new Date("2026-10-26T03:00:00Z");
const day = (n: number): FlexibleDate => dateOnly(jstDateString(new Date(NOW.getTime() + n * 86400_000)));
const hours = (n: number): FlexibleDate => dateTime(new Date(NOW.getTime() + n * 3600_000).toISOString());

function withL7(patch: Partial<Lottery>, fulfillment?: "none" | "procedure_done" | "purchased"): AppData {
  const d = createMockData(NOW);
  return {
    ...d,
    lotteries: d.lotteries.map((l) => (l.id === "L7" ? { ...l, ...patch } : l)),
    applications: d.applications.map((a) => (a.lotteryId === "L7" && fulfillment ? { ...a, fulfillment } : a)),
  };
}
const planL7 = (d: AppData, now = NOW) => planNotifications(d, {}, now).due.filter((n) => n.lotteryId === "L7");
const SPLIT = { procedureSplit: true } as const;

describe("購入期間と受取期間を分けた抽選の通知", () => {
  it("購入前は購入期限を通知し、受取期限の通知は出さない", () => {
    const d = withL7({ ...SPLIT, procedureDeadline: hours(20), receiveStart: day(10), receiveDeadline: day(20) });
    const n = planL7(d);
    expect(n.length).toBeGreaterThan(0);
    expect(n.every((x) => x.title.includes("購入"))).toBe(true);
    expect(n[0].triggerKey).toContain("p-h24"); // 購入段階のキーは接頭辞つき（受取と衝突しない）
  });

  it("購入済み（手続き済み）になると購入期限の通知は止まり、受取期限の通知に切り替わる", () => {
    const d = withL7({ ...SPLIT, procedureDeadline: hours(20), receiveStart: day(-1), receiveDeadline: hours(50) }, "procedure_done");
    const n = planL7(d);
    expect(n.every((x) => !x.title.includes("購入"))).toBe(true);
    expect(n.some((x) => x.title.includes("受取"))).toBe(true);
  });

  it("受取済みなら購入・受取どちらの通知も止まる", () => {
    const d = withL7({ ...SPLIT, procedureDeadline: hours(20), receiveDeadline: hours(30) }, "purchased");
    expect(planL7(d)).toHaveLength(0);
  });

  it("受取期間が始まった朝に『受取期間が始まりました』を1回通知する", () => {
    const d = withL7({ ...SPLIT, procedureDeadline: day(-3), receiveStart: day(0), receiveDeadline: day(7) }, "procedure_done");
    const n = planNotifications(d, {}, jstAt(jstDateString(NOW), "09:30")).due.filter((x) => x.lotteryId === "L7");
    expect(n.map((x) => x.type)).toContain("pickup_start");
  });

  it("期限を過ぎて未処理なら『期限を過ぎています』を1件だけ通知（履歴補正を促す）", () => {
    const d = withL7({ procedureDeadline: day(-1) });
    const next = jstAt(jstDateString(NOW), "09:30"); // 期限の翌朝以降
    const n = planNotifications(d, {}, next).due.filter((x) => x.lotteryId === "L7" && x.type === "procedure_overdue");
    expect(n).toHaveLength(1);
    expect(n[0].title).toContain("期限を過ぎています");
  });

  it("分離していない抽選は従来どおり（購入・受取の共通期限）", () => {
    const n = planL7(withL7({ procedureDeadline: hours(20) }));
    expect(n.map((x) => x.triggerKey.split(":")[1])).toEqual(["h24"]);
  });
});
