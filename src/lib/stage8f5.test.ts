import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { buildListRows, suggestGroupMates, summarizeGroup, type GroupRow } from "@/lib/lottery-group";
import type { AppData, LotteryGroup } from "@/types/domain";

/**
 * Stage 8F-5: グループ表示と店舗別の応募管理（親カードは表示専用・子は独立）の不変条件。
 * 新しい定義: 同一系列の複数店舗で、同一商品・同一応募期間・同一応募条件・同一抽選方式の抽選を、一覧で1つにまとめる。各店舗の抽選・応募・当選・履歴・期限は店舗別のまま。
 */
const NOW = new Date("2026-11-03T03:00:00Z");
const mk = (): { data: AppData; ids: string[] } => {
  const data = createMockData(NOW);
  return { data, ids: data.lotteries.filter((l) => l.chainId === "c1").map((l) => l.id) };
};
const withGroup = (data: AppData, ids: string[], g: Partial<LotteryGroup> = {}): AppData => ({
  ...data,
  lotteryGroups: [{ id: "G1", chainId: "c1", title: "", origin: "ai", basis: {}, ...g }],
  lotteries: data.lotteries.map((l) => (ids.includes(l.id) ? { ...l, groupId: "G1" } : l)),
});

describe("グループ化しても、店舗別の抽選・応募・期限は変わらない", () => {
  it("グループ化・解除は表示だけ: 子の抽選（期限・応募方法・条件・商品）と応募の記録は、そのまま", () => {
    const { data, ids } = mk();
    const grouped = withGroup(data, ids);
    for (const id of ids) {
      const before = data.lotteries.find((l) => l.id === id)!;
      const after = grouped.lotteries.find((l) => l.id === id)!;
      expect(after.groupId).toBe("G1");
      expect({ ...after, groupId: undefined }).toEqual({ ...before, groupId: undefined });
    }
    expect(grouped.applications).toEqual(data.applications); // 応募の記録は触れない
  });
  it("親カードの集計は子を変更しない。店舗ごとに締切が違っても、各子の締切は各子のまま（グループ単位に統合しない）。範囲と『店舗により異なる』を示す", () => {
    const { data, ids } = mk();
    let g = withGroup(data, ids.slice(0, 2));
    g = { ...g, lotteries: g.lotteries.map((l) => (l.id === ids[1] ? { ...l, applyDeadline: { precision: "date_only" as const, date: "2099-12-31" } } : l)) };
    const snapshot = JSON.stringify(g.lotteries);
    const row = buildListRows(g.lotteries, g).find((r) => r.kind === "group") as GroupRow;
    const s = summarizeGroup(row, g, g.profiles[0].id);
    expect(s.periodVaries).toBe(true);
    expect(JSON.stringify(g.lotteries)).toBe(snapshot);
    expect(row.members.find((l) => l.id === ids[1])!.applyDeadline).toEqual({ precision: "date_only", date: "2099-12-31" });
    expect(row.members.find((l) => l.id === ids[0])!.applyDeadline).toEqual(data.lotteries.find((l) => l.id === ids[0])!.applyDeadline);
  });
  it("応募済みと未応募が混在しても、応募済み店舗数はプロフィールごとの子の応募から数える（親は状態を持たない）", () => {
    const { data, ids } = mk();
    const g = withGroup(data, ids);
    const profile = g.profiles[0];
    const acc = g.accounts.find((a) => a.profileId === profile.id)!;
    const none: AppData = { ...g, applications: g.applications.filter((a) => !ids.includes(a.lotteryId)) };
    const one: AppData = { ...none, applications: [...none.applications, { id: "A-x", lotteryId: ids[0], accountId: acc.id, state: "applied", result: "pending", fulfillment: "none", appliedAt: NOW.toISOString() } as never] };
    const count = (d: AppData): number => summarizeGroup(buildListRows(d.lotteries, d).find((r) => r.kind === "group") as GroupRow, d, profile.id).appliedCount;
    expect(count(none)).toBe(0);
    expect(count(one)).toBe(1);
    // 別のプロフィールの応募は、このプロフィールの数に入らない
    const other = g.profiles.find((p) => p.id !== profile.id);
    if (other) {
      const oAcc = g.accounts.find((a) => a.profileId === other.id)!;
      const d2: AppData = { ...none, applications: [...none.applications, { id: "A-y", lotteryId: ids[0], accountId: oAcc.id, state: "applied", result: "pending", fulfillment: "none", appliedAt: NOW.toISOString() } as never] };
      expect(count(d2)).toBe(0);
    }
  });
  it("グループ解除後は、元の個別カード表示に戻る（順序も元のまま）。解除しても店舗の抽選は残る", () => {
    const { data, ids } = mk();
    const grouped = withGroup(data, ids.slice(0, 2));
    expect(buildListRows(grouped.lotteries, grouped).some((r) => r.kind === "group")).toBe(true);
    const dissolved: AppData = { ...grouped, lotteryGroups: [], lotteries: grouped.lotteries.map((l) => ({ ...l, groupId: undefined })) };
    const rows = buildListRows(dissolved.lotteries, dissolved);
    expect(rows.every((r) => r.kind === "single")).toBe(true);
    expect(rows.map((r) => (r.kind === "single" ? r.lottery.id : "")).filter(Boolean)).toEqual(data.lotteries.map((l) => l.id));
  });
});

describe("手動グループ化の候補（新定義）: 同一店舗の重複・店舗選択式は候補にしない", () => {
  it("系列・商品・応募期間・発表日・応募方式が同じ別店舗だけ。同じ店舗の重複と、店舗選択式の抽選は候補にしない", () => {
    const { data, ids } = mk();
    const a = data.lotteries.find((l) => l.id === ids[0])!;
    const b = { ...data.lotteries.find((l) => l.id === ids[1])!, applyDeadline: a.applyDeadline, resultDate: a.resultDate, applyStart: a.applyStart, applyMethod: a.applyMethod, items: a.items, storeId: "store-other" };
    const dupStore = { ...b, id: "LDUP", storeId: a.storeId };
    const select = { ...b, id: "LSEL", storeMode: "select_on_apply" as const };
    expect(suggestGroupMates(a, [a, b, dupStore, select]).map((l) => l.id)).toEqual([b.id]);
    expect(suggestGroupMates({ ...a, storeMode: "select_on_apply" }, [a, b])).toEqual([]);
  });
});
