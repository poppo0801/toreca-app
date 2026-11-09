import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { AppData, Application, Lottery } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
let profileIdx = 0;
const actions = new Proxy({} as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : vi.fn(async () => ({ ok: true, data }))) });
vi.mock("next/navigation", () => ({ usePathname: () => "/lotteries", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[profileIdx], settings: {}, actions, persistent: true, reload: async () => {} }),
}));
vi.mock("@/app/(app)/lotteries/seen-actions", () => ({ markLotterySeen: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/settings/rules/actions", () => ({ addSkipRuleAction: vi.fn(), removeSkipRuleAction: vi.fn(), setLimitExemptionAction: vi.fn(), setSkipExceptionAction: vi.fn() }));
vi.mock("@/components/lottery-form", () => ({ LotteryFormDialog: () => null }));
vi.mock("@/components/duplicate-dialog", () => ({ DuplicateDialog: () => null }));
vi.mock("@/components/ongoing-ops", () => ({ OngoingOps: () => null }));
vi.mock("@/components/past-apply-recorder", () => ({ PastApplyRecorder: () => null }));

import { LotteryDetailSheet } from "@/components/lottery-detail-sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const patch = (id: string, p: Partial<Lottery>) => {
  data = { ...data, lotteries: data.lotteries.map((l) => (l.id === id ? { ...l, ...p } : l)) };
};
const open = (id: string) => {
  const lottery = data.lotteries.find((l) => l.id === id)!;
  act(() => root.render(createElement(LotteryDetailSheet, { lottery, open: true, onOpenChange: () => undefined })));
};

beforeEach(() => {
  data = createMockData(NOW);
  profileIdx = 0;
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

describe("Stage 7J: 抽選詳細のレイアウト", () => {
  it("日付・期間は1項目ごとの独立した角丸カード（2列）。項目名と日時が分かれ、奇数のときは最後が横いっぱい", () => {
    open("L1");
    const grid = q("date-cards")!;
    expect(grid.className).toContain("grid-cols-2");
    const cards = [...q("date-cards")!.querySelectorAll<HTMLElement>("[data-label]")];
    expect(cards.length).toBeGreaterThanOrEqual(4);
    for (const c of cards) {
      expect(c.className).toContain("rounded-lg");
      expect(c.className).toContain("border");
      expect(c.querySelector("dt")!.textContent).toBeTruthy(); // 項目名
      expect(c.querySelector("dd")).not.toBeNull(); // 日時
    }
    const labels = cards.map((c) => c.getAttribute("data-label"));
    expect(labels.slice(0, 3)).toEqual(["応募開始", "応募締切", "当選発表"]);
    if (cards.length % 2 === 1) expect(cards.at(-1)!.className).toContain("col-span-2");
    else expect(cards.some((c) => c.className.includes("col-span-2"))).toBe(false);
  });

  it("応募締切の残り時間の表示を維持する", () => {
    open("L1");
    const deadline = q("date-deadline")!;
    expect(deadline.textContent).toMatch(/あと|今日|まで|残り|本日/);
  });

  it("購入期間と受取期間が別々のときは、無理に統合せずそれぞれ表示する", () => {
    patch("L1", { procedureSplit: true, receiveStart: { precision: "date_only", date: "2026-11-20" }, receiveDeadline: { precision: "date_only", date: "2026-11-25" } } as Partial<Lottery>);
    open("L1");
    const labels = [...q("date-cards")!.querySelectorAll<HTMLElement>("[data-label]")].map((c) => c.getAttribute("data-label"));
    expect(labels).toContain("購入期間");
    expect(labels).toContain("受取期間");
    expect(labels).not.toContain("購入・受取期間");
  });

  it("ステータス行は1行: 左=抽選の状態、右=現在のプロフィールの応募状態。応募状態はプロフィールに応じて変わる", () => {
    const l = data.lotteries.find((x) => x.id === "L1")!;
    const mine = data.accounts.find((a) => a.profileId === data.profiles[0].id)!;
    const app: Application = { id: "app-x", lotteryId: l.id, accountId: mine.id, state: "applied", result: "pending", fulfillment: "none", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } as unknown as Application;
    data = { ...data, applications: [...data.applications.filter((a) => !(a.lotteryId === l.id && a.accountId === mine.id)), app] };
    open("L1");
    const line = q("status-line")!;
    expect(line.className).toContain("flex");
    expect(line.className).not.toContain("flex-wrap"); // 2行にしない
    expect(line.querySelector('[data-testid="status-left"]')!.className).toContain("flex-nowrap");
    expect(q("my-status")!.getAttribute("data-status")).toBe("applied");
    // 別のプロフィールでは、そのプロフィールの状態
    act(() => root.unmount());
    root = createRoot(host);
    profileIdx = 1;
    open("L1");
    expect(q("my-status")?.getAttribute("data-status") ?? "other").not.toBe("applied");
  });

  it("応募・受取情報はグループ化（細い罫線）され、応募条件・応募制限・本人確認・書類が読める", () => {
    open("L1");
    const g = q("info-group")!;
    expect(g.className).toContain("divide-y");
    const text = g.textContent ?? "";
    for (const label of ["応募方法", "受取方法", "発表方法", "応募条件", "応募制限", "本人確認・書類"]) expect(text).toContain(label);
    expect(q("rules-applied")).not.toBeNull();
  });

  it("登録経路・情報源URLは下部の管理情報にあり、注意情報は管理情報に隠さず上部に出す", () => {
    patch("L1", { sourceUrls: ["https://example.invalid/a"], cautions: [{ code: "result_date_unknown", field: "resultDate", message: "当選発表日が確認できていません", at: NOW.toISOString() }] } as Partial<Lottery>);
    open("L1");
    const admin = q("admin-info")!;
    expect(admin.tagName).toBe("DETAILS");
    expect(admin.textContent).toContain("登録経路");
    expect(admin.textContent).toContain("https://example.invalid/a");
    // 注意は管理情報の外（上部）
    const caution = q("caution-section")!;
    expect(admin.contains(caution)).toBe(false);
    expect(caution.compareDocumentPosition(q("date-cards")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // 日付カードより上
    expect(q("lottery-detail")!.textContent).toContain("当選発表日が確認できていません");
    // 管理情報は詳細の下部（操作の下）
    expect(q("main-ops")!.compareDocumentPosition(admin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("スルーの操作は既存のまま（今回のみスルー）", () => {
    open("L1");
    expect(q("skip-once")).not.toBeNull();
  });

  it("店舗選択式の抽選で、現在のプロフィールが応募済みなのに店舗が未設定なら、入力を求める。他のプロフィールの店舗は変えない", () => {
    const l = data.lotteries.find((x) => x.id === "L1")!;
    const mine = data.accounts.find((a) => a.profileId === data.profiles[0].id)!;
    patch("L1", { storeMode: "select_on_apply" } as Partial<Lottery>);
    data = { ...data, applications: [...data.applications.filter((a) => !(a.lotteryId === l.id && a.accountId === mine.id)), { id: "app-s", lotteryId: l.id, accountId: mine.id, state: "applied", result: "pending", fulfillment: "none", appliedStore: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } as unknown as Application] };
    open("L1");
    const note = q("applied-store-missing")!;
    expect(note.textContent).toContain("応募店舗が未設定");
    expect(note.querySelector('[data-testid="applied-store-edit"]')).not.toBeNull();
    // 店舗が入力済みなら出さない
    act(() => root.unmount());
    root = createRoot(host);
    data = { ...data, applications: data.applications.map((a) => (a.id === "app-s" ? ({ ...a, appliedStore: { id: null, name: "梅田店", prefecture: "大阪府" } } as unknown as Application) : a)) };
    open("L1");
    expect(q("applied-store-missing")).toBeNull();
  });
});
