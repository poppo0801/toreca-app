import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { ChainCondition } from "@/lib/chain-conditions";
import type { AppData } from "@/types/domain";

const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
let profileIdx = 0;
const setState = vi.fn(async () => ({ ok: true as const }));
const saveConds = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[profileIdx], settings: {}, actions: {}, persistent: true, reload: async () => {} }),
}));
vi.mock("@/app/(app)/settings/conditions/actions", () => ({
  setConditionStateAction: (...a: unknown[]) => (setState as unknown as (...x: unknown[]) => Promise<unknown>)(...a),
  saveChainConditionsAction: (...a: unknown[]) => (saveConds as unknown as (...x: unknown[]) => Promise<unknown>)(...a),
}));

import { ConditionsView } from "@/components/conditions-view";
import { EligibilityMark } from "@/components/eligibility-mark";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const flush = () => act(async () => { await Promise.resolve(); });
const cond = (over: Partial<ChainCondition>): ChainCondition => ({ id: "k1", chainId: data.chains[0].id, kind: "member_card", label: "", params: {}, note: "", joinPrev: "and", sortOrder: 0, ...over });

beforeEach(() => {
  data = createMockData(NOW);
  profileIdx = 0;
  setState.mockClear();
  saveConds.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="condition-row"]')];

describe("抽選条件管理の一覧", () => {
  it("条件のある系列だけを既定で表示し、行全体が1つのボタン（個別の編集ボタンは無い）。アイコン＋短いラベルと各プロフィールの状態を出す", () => {
    data.chainConditions = [cond({ id: "k1", kind: "member_card" }), cond({ id: "k2", kind: "line", sortOrder: 1 })];
    data.chainConditionStates = [
      { id: "s1", conditionId: "k1", profileId: data.profiles[0].id, state: "met", confirmedOn: "2026-10-01", note: "" },
      { id: "s2", conditionId: "k2", profileId: data.profiles[0].id, state: "met", confirmedOn: "2026-10-01", note: "" },
    ];
    act(() => root.render(createElement(ConditionsView)));
    expect(rows()).toHaveLength(1);
    const row = rows()[0];
    expect(row.tagName).toBe("BUTTON");
    expect(row.querySelectorAll("button")).toHaveLength(0); // 行の中に別のボタンは無い
    expect(row.textContent).toContain("会員");
    expect(row.textContent).toContain("LINE");
    const states = row.querySelector('[data-testid="profile-states"]')!.textContent!;
    expect(states).toContain(`${data.profiles[0].label}：達成`);
    expect(states).toContain(`${data.profiles[1].label}：未確認`);
    expect(row.querySelector('[data-state="met"][data-kind="member_card"]')).not.toBeNull();
  });

  it("「すべての系列」で未登録の系列も表示される", () => {
    data.chainConditions = [cond({})];
    act(() => root.render(createElement(ConditionsView)));
    const n = rows().length;
    act(() => host.querySelectorAll<HTMLElement>('[role="tab"]')[1].click());
    expect(rows().length).toBeGreaterThan(n);
    expect(rows().some((r) => r.textContent?.includes("条件は未登録"))).toBe(true);
  });

  it("購入条件の資格残り期間を月単位で表示する（あとNヶ月）", () => {
    data.chainConditions = [cond({ kind: "purchase", params: { baseDaysBefore: 0, windowDays: 365 } })];
    const chain = data.chains[0];
    const store = data.stores.find((s) => s.chainId === chain.id)!;
    data.purchases = [{ id: "p", applicationId: null, storeId: store.id, buyerProfileId: data.profiles[0].id, purchasedOn: { precision: "date_only", date: "2026-03-01" }, channel: "store", source: "manual", note: "", items: [{ productId: null, quantity: 1, unit: "box", amountPaid: 5000 }] }];
    act(() => root.render(createElement(ConditionsView)));
    expect(rows()[0].querySelector('[data-testid="remaining"]')?.textContent).toMatch(/あと\d+ヶ月|まもなく資格切れ/);
  });

  it("行をタップすると詳細・編集が開き、手動条件の状態を保存できる（最終確認日つき）", async () => {
    data.chainConditions = [cond({ kind: "newsletter" })];
    act(() => root.render(createElement(ConditionsView)));
    act(() => rows()[0].click());
    const sheet = document.querySelector('[data-testid="condition-sheet"]');
    expect(sheet).not.toBeNull();
    const btn = sheet!.querySelector<HTMLElement>('[data-profile="' + data.profiles[0].label + '"] [data-testid="state-met"]')!;
    await act(async () => btn.click());
    await flush();
    expect(setState).toHaveBeenCalledWith("k1", data.profiles[0].id, "met", "2026-11-03", data.profiles[0].id);
  });

  it("サブユーザーは対象系列だけを見られ、自分以外のプロフィールの状態は出ない", () => {
    const [chainA, chainB] = data.chains;
    data.chainConditions = [cond({ id: "ka", chainId: chainA.id }), cond({ id: "kb", chainId: chainB.id })];
    data.profiles = data.profiles.map((p, i) => (i === 2 ? { ...p, kind: "sub" as const, allowedChainIds: [chainA.id] } : p));
    profileIdx = 2;
    act(() => root.render(createElement(ConditionsView)));
    expect(rows().map((r) => r.dataset.chain)).toEqual([chainA.name]);
    const states = rows()[0].querySelector('[data-testid="profile-states"]')!.textContent!;
    expect(states).toContain(data.profiles[2].label);
    expect(states).not.toContain(data.profiles[0].label);
  });
});

describe("抽選カードの資格表示", () => {
  const lottery = () => data.lotteries.find((l) => l.chainId === data.chains[0].id && !data.applications.some((a) => a.lotteryId === l.id && a.accountId && data.accounts.find((x) => x.id === a.accountId)?.profileId === data.profiles[0].id))!;
  it("条件未登録・達成済みでは何も出さない。未達成は警告、未確認は確認マーク", () => {
    const l = lottery();
    act(() => root.render(createElement(EligibilityMark, { lottery: l })));
    expect(host.querySelector('[data-testid="eligibility-mark"]')).toBeNull();
    data.chainConditions = [cond({ kind: "app_account" })];
    act(() => root.render(createElement(EligibilityMark, { lottery: l })));
    expect(host.querySelector('[data-testid="eligibility-mark"]')?.getAttribute("data-state")).toBe("unknown");
    data.chainConditionStates = [{ id: "s", conditionId: "k1", profileId: data.profiles[0].id, state: "unmet", confirmedOn: null, note: "" }];
    act(() => root.render(createElement(EligibilityMark, { lottery: l })));
    expect(host.querySelector('[data-testid="eligibility-mark"]')?.getAttribute("data-state")).toBe("unmet");
    data.chainConditionStates = [{ id: "s", conditionId: "k1", profileId: data.profiles[0].id, state: "met", confirmedOn: null, note: "" }];
    act(() => root.render(createElement(EligibilityMark, { lottery: l })));
    expect(host.querySelector('[data-testid="eligibility-mark"]')).toBeNull();
  });
  it("登録条件と今回の応募条件が異なると相違マークが出る（達成済みでも）。応募記録は禁止しない（マークのみ）", () => {
    const l = { ...lottery(), requirementTags: ["line_register" as const] };
    data.chainConditions = [cond({ kind: "app_account" })];
    data.chainConditionStates = [{ id: "s", conditionId: "k1", profileId: data.profiles[0].id, state: "met", confirmedOn: null, note: "" }];
    act(() => root.render(createElement(EligibilityMark, { lottery: l })));
    const m = host.querySelector('[data-testid="eligibility-mark"]')!;
    expect(m.getAttribute("data-mismatch")).toBe("1");
    expect(m.querySelector("button")).toBeNull();
  });
});
