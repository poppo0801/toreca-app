import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { defaultFiltersFor, selectLotteries, tabOf, type Tab } from "@/lib/lottery-view";
import { resolveUserScope, DEFAULT_USER_SCOPE } from "@/lib/user-scope";
import * as m from "@/lib/mutations";
import type { AppData } from "@/types/domain";

const NOW = new Date("2026-10-26T03:00:00Z");
const TABS: Tab[] = ["won", "applied", "managed", "all"];
const anyFilter = (tab: Tab) => ({ ...defaultFiltersFor(tab), status: "any" as const, skip: "include" as const });
const idsIn = (d: AppData, tab: Tab, profile: string, scope?: ReadonlySet<string>) => selectLotteries(d, tab, anyFilter(tab), NOW, profile, undefined, scope).map((l) => l.id);

describe("Stage 6L: 4タブの重複排除（当選 → 応募済み → 要チェック → 全情報）", () => {
  it("どのユーザーから見ても、同じ抽選は1つのタブにだけ出る。4タブを合わせると全抽選", () => {
    const d = createMockData(NOW);
    for (const p of ["pA", "pB"]) {
      const lists = TABS.map((t) => idsIn(d, t, p));
      const all = lists.flat();
      expect(new Set(all).size).toBe(all.length); // 重複なし
      expect(all.length).toBe(d.lotteries.length); // 取りこぼしなし
    }
  });

  it("全情報で★を付けると、全情報から消えて要チェックに移る。★を外すと全情報へ戻る", () => {
    const d = createMockData(NOW);
    const id = idsIn(d, "all", "pB").find((x) => !d.applications.some((a) => a.lotteryId === x))!;
    expect(id).toBeTruthy();
    const starred = m.setManaged(d, "pB", id, true, NOW);
    expect(idsIn(starred, "all", "pB")).not.toContain(id);
    expect(idsIn(starred, "managed", "pB")).toContain(id);
    const off = m.setManaged(starred, "pB", id, false, NOW);
    expect(idsIn(off, "all", "pB")).toContain(id);
    expect(idsIn(off, "managed", "pB")).not.toContain(id);
  });

  it("要チェックの抽選を応募済みにすると要チェックから応募済みへ、結果が当選なら当選へ移る（途中のタブには残らない）", () => {
    const d = createMockData(NOW);
    const id = idsIn(d, "managed", "pA").find((x) => !d.applications.some((a) => a.lotteryId === x))!;
    expect(id).toBeTruthy();
    const applied = m.setApplied(d, "pA", id, "a-c1", true, NOW);
    expect(tabOf(applied, applied.lotteries.find((l) => l.id === id)!, resolveUserScope(applied.profiles, "pA", DEFAULT_USER_SCOPE))).toBe("applied");
    expect(idsIn(applied, "managed", "pA")).not.toContain(id);
    const appId = applied.applications.find((a) => a.lotteryId === id)!.id;
    const won = m.setResult(applied, "pA", appId, "won", NOW);
    expect(idsIn(won, "won", "pA")).toContain(id);
    expect(idsIn(won, "applied", "pA")).not.toContain(id);
  });

  it("他のユーザーの応募だけでは、本人の全情報・要チェックの分類は変わらない（既定の表示範囲は本人＋紐づくサブ）", () => {
    const d = createMockData(NOW);
    const id = idsIn(d, "managed", "pB").find((x) => !d.applications.some((a) => a.lotteryId === x))!;
    const aApplied = m.setApplied(d, "pA", id, "a-c1", true, NOW);
    expect(idsIn(aApplied, "applied", "pA")).toContain(id);
    expect(idsIn(aApplied, "managed", "pB")).toContain(id); // Bの要チェックには残る
    expect(idsIn(aApplied, "applied", "pB")).not.toContain(id);
    // 「全ユーザー」を選んだときだけ、他のユーザーの応募もその人の応募済みタブに出る（1抽選=1枚）
    const everyone = new Set(aApplied.profiles.map((p) => p.id));
    expect(idsIn(aApplied, "applied", "pB", everyone).filter((x) => x === id)).toHaveLength(1);
    expect(idsIn(aApplied, "managed", "pB", everyone)).not.toContain(id);
  });

  it("退出アニメーション中のカード（keepIds）は、分類が変わっても今のタブに残る", () => {
    const d = createMockData(NOW);
    const id = idsIn(d, "all", "pB")[0];
    const starred = m.setManaged(d, "pB", id, true, NOW);
    expect(selectLotteries(starred, "all", anyFilter("all"), NOW, "pB", new Set([id])).map((l) => l.id)).toContain(id);
  });

  it("タブの件数は表示される一覧の件数と一致する（4タブの合計が全抽選）", () => {
    const d = createMockData(NOW);
    const counts = TABS.map((t) => selectLotteries(d, t, anyFilter(t), NOW, "pA").length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(d.lotteries.length);
  });
});
