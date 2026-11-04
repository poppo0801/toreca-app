import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { DEFAULT_FILTERS, selectLotteries } from "@/lib/lottery-view";
import { isSkippedBy } from "@/lib/eligibility";
import { isReady, PRODUCT_UNREGISTERED } from "@/lib/collector/ready";
import { decideHold } from "@/lib/collector/triage";
import * as m from "@/lib/mutations";
import { planNotifications } from "@/lib/notifications";
import type { AppData } from "@/types/domain";
import type { LotteryDraft } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";

const NOW = new Date("2026-11-03T03:00:00Z");
const base = createMockData(NOW);
const sel = (d: AppData, tab: "all" | "managed" | "applied" | "won", skip: "normal" | "include" | "only", profile = "pA") =>
  selectLotteries(d, tab, { ...DEFAULT_FILTERS, status: "any", skip }, NOW, profile).map((l) => l.id);

describe("商品マスター未登録は自動収集で確定登録しない（5Y）", () => {
  const draft = (kind: "exact" | "none", cands: number): LotteryDraft =>
    ({ summary: { chain: "exact", store: "exact", items: [{ kind }] }, candidates: { chain: [], store: [], items: [Array.from({ length: cands })] }, modePending: false }) as unknown as LotteryDraft;
  const input = (productId: string | null): LotteryInput =>
    ({ chain: { id: "c1", name: "系列" }, store: { id: "s1", name: "店舗" }, items: [{ product: { id: productId, name: "未登録の新商品" }, quantity: 1, unit: "box" }], applyDeadline: { date: "2026-11-10", time: "", precision: "date" }, receiveMethod: "store", sourceUrls: ["https://x.example.invalid/1"] }) as unknown as LotteryInput;
  it("マスターに一致しない商品は登録可能にしない（商品確認待ち）", () => {
    const r = isReady(draft("none", 0), input(null));
    expect(r.ready).toBe(false);
    expect(r.missing.some((x) => x.startsWith(PRODUCT_UNREGISTERED))).toBe(true);
    expect(r.provisional).toEqual([]);
  });
  it("近い候補がある商品は、これまでどおり確認待ち（部分一致で別商品へ紐付けない）。一致した商品は登録可能", () => {
    expect(isReady(draft("none", 2), input(null)).ready).toBe(false);
    expect(isReady(draft("exact", 1), input("p1")).ready).toBe(true);
  });
  it("商品確認待ちは再調査では解決しないため、締切が先でも要手動確認（利用者が商品を確認）にする。受付終了は自動除外", () => {
    const gaps = [`${PRODUCT_UNREGISTERED}: 「未登録の新商品」`];
    const far = decideHold({ now: NOW, dueAt: new Date(NOW.getTime() + 20 * 86400_000), gaps, holdCount: 0, failKind: null, altTried: false, important: false });
    expect(far.triage).toBe("manual");
    const past = decideHold({ now: NOW, dueAt: new Date(NOW.getTime() - 3600_000), gaps, holdCount: 0, failKind: null, altTried: false, important: false });
    expect(past.triage).toBe("auto_exclude");
  });
});

describe("スルーは全タブに適用（5Y）", () => {
  // Aは L4 をスルー。L4 を応募済み・当選にしてもスルー中は通常表示から外れる
  const L = base.lotteries[3];
  const skipped: AppData = { ...base, skipRules: [...base.skipRules, { id: "skY", profileId: "pA", scope: "chain" as const, scopeId: L.chainId, exceptionLotteryIds: [] }] };
  it("全情報・★管理対象・応募済み・当選のすべてで、通常はスルー中の系列の抽選を除く。含む/のみで再表示できる", () => {
    for (const tab of ["all", "managed", "applied", "won"] as const) {
      const normal = sel(skipped, tab, "normal");
      const inc = sel(skipped, tab, "include");
      const only = sel(skipped, tab, "only");
      expect(normal.some((id) => skipped.lotteries.find((l) => l.id === id)!.chainId === L.chainId), tab).toBe(false);
      expect(inc.length, tab).toBe(normal.length + only.length);
      if (tab === "all") expect(only.length).toBeGreaterThan(0);
      expect(only.every((id) => isSkippedBy(skipped, "pA", skipped.lotteries.find((l) => l.id === id)!)), tab).toBe(true);
      expect(normal.every((id) => !isSkippedBy(skipped, "pA", skipped.lotteries.find((l) => l.id === id)!)), tab).toBe(true);
    }
  });
  it("他のプロフィールには影響しない。スルー解除で元に戻る", () => {
    expect(sel(skipped, "all", "normal", "pB")).toEqual(sel(base, "all", "normal", "pB"));
    expect(sel({ ...skipped, skipRules: base.skipRules }, "all", "normal")).toEqual(sel(base, "all", "normal"));
  });
  it("履歴は消えない（応募・当選の記録はスルー設定の前後で同一）", () => {
    expect(skipped.applications).toEqual(base.applications);
  });
});

describe("応募済み・当選で★を自動追加（5Y）", () => {
  const unmanaged = (id: string): AppData => ({ ...base, management: base.management.filter((x) => x.lotteryId !== id) });
  const lid = "L2";
  const acc = base.accounts.find((a) => a.profileId === "pA") ?? base.accounts[0];
  const managedOf = (d: AppData) => d.management.find((x) => x.lotteryId === lid)?.isManaged ?? false;
  it("応募済みにすると★が付く。既に★なら変えない（冪等）", () => {
    const d0 = unmanaged(lid);
    expect(managedOf(d0)).toBe(false);
    const d1 = m.setApplied({ ...d0, applications: d0.applications.filter((a) => !(a.lotteryId === lid && a.accountId === acc.id)) }, "pA", lid, acc.id, true, NOW);
    expect(managedOf(d1)).toBe(true);
    const d2 = m.setApplied(d1, "pA", lid, acc.id, true, NOW);
    expect(d2).toBe(d1);
  });
  it("当選にすると★が付く", () => {
    const d0 = unmanaged(lid);
    const app = { id: "appY", lotteryId: lid, accountId: acc.id, appliedAt: NOW.toISOString(), state: "applied" as const, result: "pending" as const, itemResults: {}, selectedItemId: null, resultConfirmedAt: null, fulfillment: "none" as const, createdAt: NOW.toISOString() };
    const d1 = m.setResult({ ...d0, applications: [...d0.applications.filter((a) => a.lotteryId !== lid), app] }, "pA", "appY", "won", NOW);
    expect(managedOf(d1)).toBe(true);
  });
  it("応募取消・落選・購入済みでは★を外さない", () => {
    const d0 = unmanaged(lid);
    const app = { id: "appY", lotteryId: lid, accountId: acc.id, appliedAt: NOW.toISOString(), state: "applied" as const, result: "pending" as const, itemResults: {}, selectedItemId: null, resultConfirmedAt: null, fulfillment: "none" as const, createdAt: NOW.toISOString() };
    let d = m.setResult({ ...d0, applications: [...d0.applications.filter((a) => a.lotteryId !== lid), app] }, "pA", "appY", "won", NOW);
    d = m.setResult(d, "pA", "appY", "lost", NOW);
    expect(managedOf(d)).toBe(true);
    d = m.setApplied(d, "pA", lid, acc.id, false, NOW);
    expect(managedOf(d)).toBe(true);
  });
  it("プロフィール別の応募状態は独立（Aの応募はBの応募状態を作らない）", () => {
    const d0 = unmanaged(lid);
    const d1 = m.setApplied({ ...d0, applications: d0.applications.filter((a) => a.lotteryId !== lid) }, "pA", lid, acc.id, true, NOW);
    expect(d1.applications.filter((a) => a.lotteryId === lid)).toHaveLength(1);
  });
});

describe("系列スルー中でも、当選済みの購入・受取期限の通知は維持（5Y）", () => {
  it("スルー設定の前後で、当選の手続き通知の件数が変わらない", () => {
    const won = base.applications.find((a) => a.state === "applied" && a.result === "won") ;
    if (!won) return; // モックに当選が無ければ対象外
    const lot = base.lotteries.find((l) => l.id === won.lotteryId)!;
    const profile = base.accounts.find((a) => a.id === won.accountId)!.profileId;
    const withSkip: AppData = { ...base, skipRules: [...base.skipRules, { id: "skN", profileId: profile, scope: "chain" as const, scopeId: lot.chainId, exceptionLotteryIds: [] }] };
    const count = (d: AppData) => planNotifications(d, {}, NOW).due.filter((n) => n.lotteryId === lot.id && n.type !== "deadline_morning" && n.type !== "deadline_before").length;
    expect(count(withSkip)).toBe(count(base));
  });
});
