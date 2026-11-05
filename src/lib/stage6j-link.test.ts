import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { canOperateOwner, linkCandidates, linkedSubIds, ownerIdOf, scopedApplications, scopeProfileIds, validateLink } from "@/lib/profile-link";
import { defaultFiltersFor, selectLotteries } from "@/lib/lottery-view";
import { tabDots } from "@/lib/notifications";
import type { AppData, Application } from "@/types/domain";

const NOW = new Date("2026-10-26T03:00:00Z");

/** A・B（メイン）と C（サブ。系列c1のみ）。C は A に紐づける */
function base(): AppData {
  const d = createMockData(NOW);
  return { ...d, profiles: d.profiles.map((p) => (p.id === "pC" ? { ...p, linkedMainId: "pA" } : p)) };
}
const clone = (d: AppData, patch: Partial<Application> & { id: string; lotteryId: string; accountId: string }): Application => ({ ...d.applications[0], state: "applied", result: "pending", fulfillment: "none", ...patch });
const withApps = (d: AppData, apps: Application[]): AppData => ({ ...d, applications: [...d.applications, ...apps] });
const ids = (d: AppData, tab: "applied" | "won", profileId: string) => selectLotteries(d, tab, defaultFiltersFor(tab), NOW, profileId).map((l) => l.id).sort();

describe("Stage 6J: メイン／サブの紐づけと表示範囲", () => {
  it("A(メイン)=A+紐づくC / B=Bのみ / C(サブ)=Cのみ。未紐づけなら A はAのみ", () => {
    const d = base();
    expect(scopeProfileIds(d.profiles, "pA")).toEqual(["pA", "pC"]);
    expect(scopeProfileIds(d.profiles, "pB")).toEqual(["pB"]);
    expect(scopeProfileIds(d.profiles, "pC")).toEqual(["pC"]);
    const unlinked = { ...d, profiles: d.profiles.map((p) => ({ ...p, linkedMainId: null })) };
    expect(scopeProfileIds(unlinked.profiles, "pA")).toEqual(["pA"]);
    expect(linkedSubIds(d.profiles, "pA")).toEqual(["pC"]);
    expect(linkedSubIds(d.profiles, "pB")).toEqual([]);
  });

  it("紐づけの規則: サブ→メインだけ。サブ同士・自分自身・メイン→メイン・無効なユーザーは不可。解除は可", () => {
    const d = base();
    const withSub2 = [...d.profiles, { id: "pD", label: "D", kind: "sub" as const, color: "teal" as const, initial: "D", allowedChainIds: ["c1"], allowedStoreIds: [], blockedChainIds: [], blockedStoreIds: [] }];
    expect(validateLink(withSub2, "pC", "pB")).toEqual({ ok: true });
    expect(validateLink(withSub2, "pC", null)).toEqual({ ok: true });
    expect(validateLink(withSub2, "pC", "pD").ok).toBe(false); // サブ同士
    expect(validateLink(withSub2, "pC", "pC").ok).toBe(false); // 自分自身
    expect(validateLink(withSub2, "pA", "pB").ok).toBe(false); // メインは紐づけられない
    expect(validateLink(withSub2.map((p) => (p.id === "pB" ? { ...p, active: false } : p)), "pC", "pB").ok).toBe(false);
    expect(linkCandidates(withSub2, "pC").map((p) => p.id)).toEqual(["pA", "pB"]); // サブ・自分は候補に出ない
  });

  it("応募済みタブ: AにはC(紐づく)の応募も出る。BにはCの履歴は出ない。CにはC自身だけ", () => {
    const d0 = base();
    // c1 の抽選で、まだ誰も応募していないものにCだけが応募
    const only = d0.lotteries.find((l) => l.chainId === "c1" && !d0.applications.some((a) => a.lotteryId === l.id))!;
    const d = withApps(d0, [clone(d0, { id: "apC", lotteryId: only.id, accountId: "c-c1" })]);
    expect(ids(d, "applied", "pA")).toContain(only.id);
    expect(ids(d, "applied", "pB")).not.toContain(only.id);
    expect(ids(d, "applied", "pC")).toEqual([only.id]);
    // 紐づけを外すとAの一覧から消える（応募の記録は残る）
    const off = { ...d, profiles: d.profiles.map((p) => ({ ...p, linkedMainId: null })) };
    expect(ids(off, "applied", "pA")).not.toContain(only.id);
    expect(off.applications.some((a) => a.id === "apC")).toBe(true);
  });

  it("当選タブ: AにはCの当選も出る。BにはCの当選は出ない。他のメインの当選は混ざらない", () => {
    const d0 = base();
    const only = d0.lotteries.find((l) => l.chainId === "c1" && !d0.applications.some((a) => a.lotteryId === l.id))!;
    const d = withApps(d0, [clone(d0, { id: "wC", lotteryId: only.id, accountId: "c-c1", result: "won" })]);
    expect(ids(d, "won", "pA")).toContain(only.id);
    expect(ids(d, "won", "pB")).not.toContain(only.id);
    expect(ids(d, "won", "pC")).toEqual([only.id]);
    // L7: A当選・B落選 → Bの当選タブには出ない（Aの履歴は混ざらない）
    expect(ids(d, "won", "pB")).not.toContain("L7");
    expect(ids(d, "won", "pA")).toContain("L7");
  });

  it("同じ抽選にAとCが応募: カードは1枚。応募実績はユーザーごとに別々に数える（二重計上しない）", () => {
    const d0 = base();
    const target = d0.lotteries.find((l) => l.chainId === "c1" && !d0.applications.some((a) => a.lotteryId === l.id))!;
    const d = withApps(d0, [clone(d0, { id: "apA", lotteryId: target.id, accountId: "a-c1" }), clone(d0, { id: "apC", lotteryId: target.id, accountId: "c-c1" })]);
    const aIds = ids(d, "applied", "pA");
    expect(aIds.filter((x) => x === target.id)).toHaveLength(1); // カードは重複しない
    const scoped = scopedApplications(d, target.id, new Set(scopeProfileIds(d.profiles, "pA")));
    expect(scoped.map((a) => ownerIdOf(d, a)).sort()).toEqual(["pA", "pC"]); // 応募は2件（ユーザー別）
    const byOwner = (pid: string) => d.applications.filter((a) => a.state === "applied" && ownerIdOf(d, a) === pid).length;
    expect(byOwner("pA")).toBe(d0.applications.filter((a) => ownerIdOf(d0, a) === "pA").length + 1);
    expect(byOwner("pC")).toBe(1);
  });

  it("全情報・★管理対象は世帯共通（紐づけの影響を受けない）。サブの対象系列制限は維持される", () => {
    const d = base();
    const plain = { ...d, profiles: d.profiles.map((p) => ({ ...p, linkedMainId: null })) };
    for (const tab of ["all", "managed"] as const) {
      expect(selectLotteries(d, tab, defaultFiltersFor(tab), NOW, "pA").map((l) => l.id)).toEqual(selectLotteries(plain, tab, defaultFiltersFor(tab), NOW, "pA").map((l) => l.id));
    }
    // Cは系列c1のみ表示（c2以降は見えない）
    const cAll = selectLotteries(d, "all", { ...defaultFiltersFor("all"), status: "any", skip: "include" }, NOW, "pC");
    expect(cAll.length).toBeGreaterThan(0);
    expect(cAll.every((l) => l.chainId === "c1")).toBe(true);
    // Aの応募済みタブにも、Cが対象外の系列の抽選にCの応募があっても出ない（対象外の系列は元々応募できない）
  });

  it("赤丸(タブのドット)もタブの表示範囲と一致する。通知の送り先設定は変わらない", () => {
    const d0 = base();
    const only = d0.lotteries.find((l) => l.chainId === "c1" && !d0.applications.some((a) => a.lotteryId === l.id))!;
    const d = withApps(d0, [clone(d0, { id: "wC", lotteryId: only.id, accountId: "c-c1", result: "won" })]);
    expect(tabDots(d, "pA", NOW).wonDot).toBe(true);
    const onlyC = { ...d, applications: d.applications.filter((a) => a.id === "wC") };
    expect(tabDots(onlyC, "pA", NOW).wonDot).toBe(true); // Aのタブに表示される範囲
    expect(tabDots(onlyC, "pB", NOW).wonDot).toBe(false); // Bには表示されない
    expect(d.profiles.map((p) => p.notifyRecipientIds)).toEqual(d0.profiles.map((p) => p.notifyRecipientIds));
  });

  it("操作できる所有者: 本人と、本人に紐づくサブだけ（他のメイン・紐づかないサブは不可）", () => {
    const d = base();
    expect(canOperateOwner(d.profiles, "pA", "pA")).toBe(true);
    expect(canOperateOwner(d.profiles, "pA", "pC")).toBe(true);
    expect(canOperateOwner(d.profiles, "pB", "pC")).toBe(false);
    expect(canOperateOwner(d.profiles, "pC", "pA")).toBe(false);
    expect(canOperateOwner(d.profiles, "pA", "pB")).toBe(false);
  });
});
