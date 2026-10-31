import { describe, expect, it } from "vitest";
import { dateOnly, dateTime, formatPlain } from "@/lib/datetime";
import { accountsForLottery } from "@/lib/eligibility";
import { profileMarks } from "@/lib/lottery-summary";
import { InMemoryRepository } from "@/services/memory-repository";
import { viewport } from "@/app/layout";

const NOW = new Date("2026-10-26T03:00:00Z");

describe("プロフィールの表示順（全画面で共通の定義）", () => {
  it("応募状況・詳細・フォームの並びは data.profiles の順。順序を入れ替えると、アカウントの並びも同じ順に変わる", async () => {
    const repo = new InMemoryRepository();
    const d0 = await repo.load(NOW);
    const l = d0.lotteries.find((x) => x.id === "L3")!;
    const ids = (d: typeof d0) => accountsForLottery(d, l).map((a) => a.profileId);
    expect(ids(d0)).toEqual(["pA", "pB", "pC"]);
    const res = await repo.reorderProfiles("pA", ["pC", "pA", "pB"]);
    expect(res.ok).toBe(true);
    const d1 = res.ok ? res.data : d0;
    expect(d1.profiles.map((p) => p.id)).toEqual(["pC", "pA", "pB"]);
    expect(ids(d1)).toEqual(["pC", "pA", "pB"]);
    expect(profileMarks(d1, l, NOW).map((m) => m.profileId)).toEqual(["pC", "pA", "pB"]);
  });

  it("並べ替えても、プロフィールID・応募記録・当落は変わらない", async () => {
    const repo = new InMemoryRepository();
    const d0 = await repo.load(NOW);
    const res = await repo.reorderProfiles("pA", ["pB", "pC", "pA"]);
    const d1 = res.ok ? res.data : d0;
    expect(d1.applications).toEqual(d0.applications);
    expect(new Set(d1.profiles.map((p) => p.id))).toEqual(new Set(d0.profiles.map((p) => p.id)));
  });
});

describe("日付の表示（詳細に「時刻未確認」を出さない）", () => {
  it("日付のみは 11/7 だけ（内部の精度は date_only のまま）。時刻つきはそのまま", () => {
    expect(formatPlain(dateOnly("2026-11-07"))).toBe("11/7");
    expect(formatPlain(dateOnly("2026-11-07"))).not.toContain("時刻未確認");
    expect(formatPlain(dateTime("2026-11-07T03:00:00Z"))).toBe("11/7 12:00");
    expect(dateOnly("2026-11-07")).toEqual({ precision: "date_only", date: "2026-11-07" }); // 23:59などは補わない
  });
});

describe("入力時の自動拡大の抑制（viewport）", () => {
  it("最大倍率1・拡大の禁止。Safe Area用の viewport-fit=cover は変えない", () => {
    expect(viewport.maximumScale).toBe(1);
    expect(viewport.userScalable).toBe(false);
    expect(viewport.viewportFit).toBe("cover");
    expect(viewport.initialScale).toBe(1);
  });
});
