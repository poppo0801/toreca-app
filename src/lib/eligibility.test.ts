import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { effectiveRules, hasSkipException, inProfileScope, judgeAccount, skipSourceFor } from "@/lib/eligibility";
import { isManaged } from "@/lib/lottery-view";
import * as m from "@/lib/mutations";
import type { AppData, Lottery } from "@/types/domain";

const NOW = new Date("2026-10-26T03:00:00Z");
const mk = () => createMockData(NOW);
type D = AppData;

const status = (d: D, l: string, a: string) => {
  const lot = d.lotteries.find((x) => x.id === l)!;
  return judgeAccount(d, lot, d.accounts.find((x) => x.id === a)!, NOW);
};
const withLottery = (d: D, id: string, patch: Partial<Lottery>): D => ({
  ...d,
  lotteries: d.lotteries.map((l) => (l.id === id ? { ...l, ...patch } : l)),
});
const apply = (d: D, l: string, a: string) => m.setApplied(d, "pA", l, a, true, NOW);

describe("応募制限（1人・1家族・1住所）", () => {
  it("1人1回: 名義が違えば同じ家族でも応募できる", () => {
    let d = withLottery(mk(), "L1", { limit: { basis: "person", maxCount: 1 }, campaignId: undefined });
    d = apply(d, "L1", "a-c1");
    expect(status(d, "L1", "a-c1").status).toBe("applied");
    expect(status(d, "L1", "b-c1").status).toBe("eligible_unapplied");
  });
  it("1家族1回: 同じ家族グループは枠充足、別の家族(C)は影響を受けない", () => {
    let d = withLottery(mk(), "L1", { limit: { basis: "family", maxCount: 1 }, campaignId: undefined });
    d = apply(d, "L1", "a-c1");
    expect(status(d, "L1", "b-c1")).toMatchObject({ status: "covered_by_limit" });
    expect(status(d, "L1", "c-c1").status).toBe("eligible_unapplied");
  });
  it("1住所1回: 同じ住所グループは枠充足、別住所(C)は応募できる", () => {
    let d = withLottery(mk(), "L1", { limit: { basis: "address", maxCount: 1 }, campaignId: undefined });
    d = apply(d, "L1", "a-c1");
    expect(status(d, "L1", "b-c1").status).toBe("covered_by_limit");
    expect(status(d, "L1", "c-c1").status).toBe("eligible_unapplied");
  });
  it("上限2回なら1件応募しても枠は埋まらない", () => {
    let d = withLottery(mk(), "L1", { limit: { basis: "family", maxCount: 2 }, campaignId: undefined });
    d = apply(d, "L1", "a-c1");
    expect(status(d, "L1", "b-c1").status).toBe("eligible_unapplied");
    d = apply(d, "L1", "b-c1");
    expect(status(d, "L1", "b-c1").status).toBe("applied");
  });
});

describe("キャンペーン・系列標準・抽選固有ルールの優先と併用", () => {
  it("キャンペーンの「1店舗まで」は店舗をまたいで判定される（名義単位）", () => {
    const d = mk();
    // L2(名谷)にAが応募済み → 同キャンペーンのL1(三宮)でAは枠充足、Bは応募可能
    expect(status(d, "L1", "a-c1").status).toBe("covered_by_limit");
    expect(status(d, "L1", "b-c1").status).toBe("eligible_unapplied");
  });
  it("キャンペーンのルール（家族・通算）が設定されると別名義の家族も枠充足になる", () => {
    const d0 = mk();
    const d = {
      ...d0,
      applicationRules: [
        { id: "r1", scope: "campaign" as const, scopeId: "k1", basis: "family" as const, maxCount: 1, across: "campaign" as const, confidence: "confirmed" as const },
      ],
    };
    expect(status(d, "L1", "b-c1").status).toBe("covered_by_limit");
    expect(effectiveRules(d, d.lotteries.find((l) => l.id === "L1")!).map((r) => `${r.basis}/${r.across}`).sort()).toEqual([
      "account/lottery",
      "family/campaign",
      "person/campaign",
    ]);
  });
  it("抽選固有の制限が未設定なら系列標準ルールが初期値として使われる", () => {
    const base = withLottery(mk(), "L3", { limit: { basis: "unknown", maxCount: 1 } });
    expect(status(base, "L3", "b-c2").status).toBe("needs_review"); // どのルールも無い→要確認
    const d = {
      ...base,
      applicationRules: [
        { id: "r1", scope: "chain" as const, scopeId: "c2", basis: "family" as const, maxCount: 1, across: "lottery" as const, confidence: "confirmed" as const },
      ],
    };
    // A(a-c2)が応募済み → 系列標準の1家族1回でBは枠充足
    expect(status(d, "L3", "b-c2").status).toBe("covered_by_limit");
    expect(effectiveRules(d, d.lotteries.find((l) => l.id === "L3")!)[0].source).toBe("chain");
  });
  it("抽選固有のルールがあれば系列標準は上書きされ適用されない", () => {
    let d = withLottery(mk(), "L3", { limit: { basis: "account", maxCount: 1 } });
    d = {
      ...d,
      applicationRules: [
        { id: "r1", scope: "chain" as const, scopeId: "c2", basis: "family" as const, maxCount: 1, across: "lottery" as const, confidence: "confirmed" as const },
      ],
    };
    expect(status(d, "L3", "b-c2").status).toBe("eligible_unapplied"); // 家族上限(系列標準)は無視
    expect(effectiveRules(d, d.lotteries.find((l) => l.id === "L3")!).map((r) => r.source)).toEqual(["lottery"]);
  });
  it("未確認のルールは、枠が埋まっていなければ「要確認」、埋まっていれば枠充足（通知しない）", () => {
    let d: D = {
      ...mk(),
      applicationRules: [
        { id: "r1", scope: "lottery", scopeId: "L3", basis: "account", maxCount: 1, across: "lottery", confidence: "unconfirmed" },
      ],
    };
    d = withLottery(d, "L3", { limit: { basis: "unknown", maxCount: 1 } });
    expect(status(d, "L3", "b-c2").status).toBe("needs_review");
    d = apply(d, "L3", "b-c2");
    expect(status(d, "L3", "b-c2").status).toBe("applied");
  });
  it("規約確認済みの手動例外: 指定アカウントは制限の対象外で、例外の応募は他者の枠を埋めない", () => {
    let d = mk(); // L3: 1家族1回、Aが応募済み
    expect(status(d, "L3", "b-c2").status).toBe("covered_by_limit");
    d = { ...d, limitExemptions: [{ lotteryId: "L3", accountId: "b-c2", reason: "別世帯として規約確認済み" }] };
    expect(status(d, "L3", "b-c2").status).toBe("eligible_unapplied");
    // 例外のBが応募しても、(例外扱いなので)他の名義の枠判定には数えない
    const d2 = m.setApplied(d, "pB", "L3", "b-c2", true, NOW);
    expect(status(d2, "L3", "b-c2").status).toBe("applied");
  });
});

describe("応募資格の管理", () => {
  const req = { id: "q1", chainId: "c1", kind: "membership" as const, label: "会員登録", validMonths: 12 };
  const el = (accountId: string, over: Partial<D["eligibilities"][number]> = {}) => ({
    id: `e-${accountId}`,
    accountId,
    requirementId: "q1",
    state: "eligible" as const,
    verifiedOn: "2026-01-01",
    validFrom: "2026-01-01",
    validUntil: "2027-01-01",
    ...over,
  });
  const base = (): D => ({ ...withLottery(mk(), "L1", { campaignId: undefined }), requirements: [req] });

  it("条件があるのに資格が未登録・不明なら要確認、満たせば応募可能、なしなら対象外", () => {
    const d = { ...base(), eligibilities: [el("a-c1"), el("c-c1", { state: "ineligible" }), el("b-c1", { state: "unknown" })] };
    expect(status(d, "L1", "a-c1").status).toBe("eligible_unapplied");
    expect(status(d, "L1", "b-c1")).toMatchObject({ status: "needs_review" });
    expect(status(d, "L1", "c-c1").status).toBe("ineligible");
    expect(status({ ...base(), eligibilities: [] }, "L1", "a-c1").status).toBe("needs_review");
  });
  it("有効期限切れの資格は要確認（応募可能と断定しない）", () => {
    const d = { ...base(), eligibilities: [el("a-c1", { validUntil: "2026-10-01" })] };
    expect(status(d, "L1", "a-c1")).toMatchObject({ status: "needs_review", reason: expect.stringContaining("有効期限切れ") });
    const ok = { ...base(), eligibilities: [el("a-c1", { validUntil: "2026-10-26" })] }; // 当日までは有効
    expect(status(ok, "L1", "a-c1").status).toBe("eligible_unapplied");
  });
  it("枠が埋まっていれば資格が不明でも要確認にせず枠充足（不要な通知を出さない）", () => {
    let d = { ...base(), eligibilities: [el("a-c1"), el("b-c1", { state: "unknown" })] };
    d = withLottery(d, "L1", { limit: { basis: "family", maxCount: 1 } });
    d = apply(d, "L1", "a-c1");
    expect(status(d, "L1", "b-c1").status).toBe("covered_by_limit");
  });
});

describe("応募対象（プロフィール別）とスルー", () => {
  it("店舗単位の許可リスト: 許可した店舗だけが対象。除外は常に対象外", () => {
    const d = mk();
    const c = { ...d.profiles.find((p) => p.id === "pC")!, allowedChainIds: null, allowedStoreIds: ["s1"] };
    expect(inProfileScope(c, "c1", "s1")).toBe(true);
    expect(inProfileScope(c, "c1", "s2")).toBe(false);
    expect(inProfileScope({ ...c, blockedStoreIds: ["s1"] }, "c1", "s1")).toBe(false);
    const a = d.profiles.find((p) => p.id === "pA")!;
    expect(inProfileScope(a, "c1", "s2")).toBe(true);
    expect(inProfileScope({ ...a, blockedChainIds: ["c2"] }, "c2", "s3")).toBe(false);
  });
  it("スルーは今回だけ/店舗単位/系列単位。Aのスルーは他プロフィールへ伝播しない", () => {
    const d: D = {
      ...mk(),
      skipRules: [
        { id: "k1", profileId: "pA", scope: "store", scopeId: "s1", exceptionLotteryIds: [] },
        { id: "k2", profileId: "pB", scope: "chain", scopeId: "c3", exceptionLotteryIds: [] },
      ],
    };
    const l1 = d.lotteries.find((l) => l.id === "L1")!;
    expect(skipSourceFor(d, "pA", l1)).toBe("store");
    expect(skipSourceFor(d, "pB", l1)).toBeNull();
    expect(status(d, "L6", "a-c1").status).toBe("applied"); // 応募済みは応募済みとして見せる
    expect(status(d, "L4", "b-c3")).toMatchObject({ status: "skipped", reason: "系列スルー" });
    expect(status(d, "L4", "a-c3").status).toBe("eligible_unapplied");
  });
  it("常時スルーへの「今回だけ」の例外解除と、解除の取り消し", () => {
    let d: D = { ...mk(), skipRules: [{ id: "k1", profileId: "pB", scope: "chain", scopeId: "c3", exceptionLotteryIds: [] }] };
    const l4 = d.lotteries.find((l) => l.id === "L4")!;
    expect(status(d, "L4", "b-c3").status).toBe("skipped");
    d = { ...d, skipRules: d.skipRules.map((r) => ({ ...r, exceptionLotteryIds: ["L4"] })) };
    expect(hasSkipException(d, "pB", l4)).toBe(true);
    expect(status(d, "L4", "b-c3").status).toBe("eligible_unapplied");
    d = { ...d, skipRules: d.skipRules.map((r) => ({ ...r, exceptionLotteryIds: [] })) };
    expect(status(d, "L4", "b-c3").status).toBe("skipped");
  });
  it("スルーと★管理は独立: スルーしても★は変わらず、★OFFでもスルー状態は変わらない", () => {
    let d = mk();
    d = m.setLotterySkip(d, "pA", "L1", true, NOW);
    expect(isManaged(d, "L1")).toBe(true);
    d = m.setManaged(d, "pA", "L1", false, NOW);
    expect(status(d, "L1", "a-c1").status).toBe("skipped");
    expect(status(d, "L1", "b-c1").status).toBe("eligible_unapplied");
  });
  it("スルー・対象外・応募不可・要確認・枠充足を区別する", () => {
    const d: D = { ...mk(), skipRules: [{ id: "k1", profileId: "pA", scope: "lottery", scopeId: "L4", exceptionLotteryIds: [] }] };
    expect(status(d, "L4", "a-c3").status).toBe("skipped");
    expect(status(d, "L3", "c-c2").status).toBe("ineligible"); // Cは許可リスト外
    expect(status(d, "L10", "b-c3").status).toBe("unavailable"); // 受付終了
    expect(status(d, "L5", "b-c4").status).toBe("needs_review");
    expect(status(d, "L3", "b-c2").status).toBe("covered_by_limit");
  });
});
