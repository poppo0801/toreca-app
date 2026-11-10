import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { AppData, Lottery } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
const setApplied = vi.fn(async () => ({ ok: true as const, data }));
const setAppliedItems = vi.fn(async () => ({ ok: true as const, data }));
const actions = new Proxy({ setApplied, setAppliedItems } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : vi.fn(async () => ({ ok: true, data }))) });
vi.mock("next/navigation", () => ({ usePathname: () => "/lotteries", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], settings: {}, actions, persistent: true, reload: async () => {} }),
}));
vi.mock("@/app/(app)/lotteries/seen-actions", () => ({ markLotterySeen: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/settings/rules/actions", () => ({ addSkipRuleAction: vi.fn(), removeSkipRuleAction: vi.fn(), setLimitExemptionAction: vi.fn(), setSkipExceptionAction: vi.fn() }));
vi.mock("@/components/lottery-form", () => ({ LotteryFormDialog: () => null }));
vi.mock("@/components/duplicate-dialog", () => ({ DuplicateDialog: () => null }));
vi.mock("@/components/ongoing-ops", () => ({ OngoingOps: () => null }));
vi.mock("@/components/past-apply-recorder", () => ({ PastApplyRecorder: () => null }));

import { LotteryDetailSheet } from "@/components/lottery-detail-sheet";
import { MyApplyButton } from "@/components/apply-status";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const patch = (id: string, p: Partial<Lottery>) => {
  data = { ...data, lotteries: data.lotteries.map((l) => (l.id === id ? { ...l, ...p } : l)) };
};
const lottery = (id: string) => data.lotteries.find((l) => l.id === id)!;
const openDetail = (id: string) => act(() => root.render(createElement(LotteryDetailSheet, { lottery: lottery(id), open: true, onOpenChange: () => undefined })));
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());

/** 商品を2つにして「商品ごとに当落」にする */
function makeMulti(id: string) {
  const l = lottery(id);
  patch(id, { multiMode: "all", items: [{ id: "i-a", productId: l.items[0].productId, quantity: 1, unit: "box" }, { id: "i-b", productId: l.items[0].productId, quantity: 1, unit: "box" }] });
}

beforeEach(() => {
  data = createMockData(NOW);
  setApplied.mockClear();
  setAppliedItems.mockClear();
  window.matchMedia = ((qq: string) => ({ matches: false, media: qq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("Stage 7M: 抽選詳細のレイアウト", () => {
  it("日付は個別の枠なしの2列。その他の情報は外側を角丸枠で囲み、項目間は区切り線", () => {
    openDetail("L1");
    const dates = q("date-cards")!;
    expect(dates.className).toContain("grid-cols-2");
    expect(qa("date-card").length + dates.children.length).toBeGreaterThan(0);
    for (const c of dates.children) expect(c.className).not.toMatch(/\brounded/); // 個別の角丸枠を使わない
    const info = q("info-group")!;
    expect(info.className).toMatch(/rounded-lg/);
    expect(info.className).toMatch(/\bborder\b/);
    expect(info.className).toContain("divide-y");
  });

  it("確認が必要な点: 初期は閉じ、見出しは「要確認（○件）」。開くと全文。解消された項目は消え、0件なら表示自体が消える", () => {
    patch("L1", {
      resultDate: { precision: "unknown" },
      receiveMethod: "unknown",
      cautions: [
        { code: "result_date_unknown", field: "resultDate", message: "当選発表日が確認できていません", at: "" },
        { code: "receive_method_unknown", field: "receiveMethod", message: "受取方法（店頭・発送）が確認できていません。情報元で確認してください", at: "" },
      ],
    });
    openDetail("L1");
    const sec = q("caution-section") as HTMLDetailsElement;
    expect(sec.tagName).toBe("DETAILS");
    expect(sec.open).toBe(false);
    expect(q("caution-summary")!.textContent).toContain("要確認（2件）");
    click(q("caution-summary"));
    expect(sec.open).toBe(true);
    expect(sec.textContent).toContain("受取方法（店頭・発送）が確認できていません。情報元で確認してください"); // 全文（途中で切れない）
    // 編集で受取方法を補うと1件に
    patch("L1", { receiveMethod: "store" });
    openDetail("L1");
    expect(q("caution-summary")!.textContent).toContain("要確認（1件）");
    // 発表日も補うと表示自体が消える
    patch("L1", { resultDate: { precision: "date_only", date: "2026-11-20" } });
    openDetail("L1");
    expect(q("caution-section")).toBeNull();
  });
});

describe("Stage 7M: 複数商品抽選の応募", () => {
  it("応募済みにする: 商品選択を出し、初期は全商品を選択。外した商品は応募しない。0件では確定できない", async () => {
    makeMulti("L4");
    act(() => root.render(createElement(MyApplyButton, { lottery: lottery("L4") })));
    click(q("my-apply"));
    expect(q("item-picker")).not.toBeNull();
    const checks = qa("item-picker-check") as HTMLInputElement[];
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.checked)).toBe(true);
    // 全部外すと確定できない
    for (const c of checks) click(c);
    expect((q("item-picker-ok") as HTMLButtonElement).disabled).toBe(true);
    expect(q("item-picker-zero")).not.toBeNull();
    expect(setApplied).not.toHaveBeenCalled();
    // 1つだけ選んで確定
    click(checks[0]);
    await act(async () => click(q("item-picker-ok")));
    expect(setApplied).toHaveBeenCalledTimes(1);
    const call = setApplied.mock.calls[0] as unknown[];
    expect(call[2]).toBe(true);
    expect(call[4]).toMatchObject({ itemIds: ["i-a"] });
  });

  it("単一商品の抽選は従来どおりワンタップ（商品選択は出さない）", async () => {
    act(() => root.render(createElement(MyApplyButton, { lottery: lottery("L4") })));
    await act(async () => click(q("my-apply")));
    expect(q("item-picker")).toBeNull();
    expect(setApplied).toHaveBeenCalledTimes(1);
  });

  it("従来の記録（応募商品が未指定）は、詳細に「未確認」と表示し、確認するボタンから確定できる", () => {
    makeMulti("L4");
    const acc = data.accounts.find((a) => a.profileId === data.profiles[0].id && a.chainId === lottery("L4").chainId)!;
    data = { ...data, applications: [{ id: "app-x", lotteryId: "L4", accountId: acc.id, appliedAt: null, state: "applied", result: "pending", itemResults: {}, selectedItemId: null, appliedItemIds: null, resultConfirmedAt: null, fulfillment: "none", createdAt: "" }] };
    openDetail("L4");
    expect(q("applied-items-unconfirmed")).not.toBeNull();
    expect(q("applied-items-edit")!.textContent).toBe("確認する");
    // 応募商品を確定すると、そのまま保存できる
    click(q("applied-items-edit"));
    expect(q("item-picker")).not.toBeNull();
  });

  it("応募商品が確定している応募は「変更」。選んだ商品だけを表示する", () => {
    makeMulti("L4");
    const acc = data.accounts.find((a) => a.profileId === data.profiles[0].id && a.chainId === lottery("L4").chainId)!;
    data = { ...data, applications: [{ id: "app-x", lotteryId: "L4", accountId: acc.id, appliedAt: null, state: "applied", result: "pending", itemResults: {}, selectedItemId: null, appliedItemIds: ["i-b"], resultConfirmedAt: null, fulfillment: "none", createdAt: "" }] };
    openDetail("L4");
    expect(q("applied-items-unconfirmed")).toBeNull();
    expect(q("applied-items-edit")!.textContent).toBe("変更");
    const checked = () => (qa("item-picker-check") as HTMLInputElement[]).map((c) => c.checked);
    click(q("applied-items-edit"));
    expect(checked()).toEqual([false, true]);
  });
});
