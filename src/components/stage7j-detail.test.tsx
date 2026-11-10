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
  it("日付・期間は外枠・角丸なしの区切り線形式（2列）。項目名と日時が分かれ、最後の行以外にだけ薄い区切り線。奇数のときは最後が横いっぱい", () => {
    open("L1");
    const grid = q("date-cards")!;
    expect(grid.className).toContain("grid-cols-2");
    const cards = [...q("date-cards")!.querySelectorAll<HTMLElement>("[data-label]")];
    expect(cards.length).toBeGreaterThanOrEqual(4);
    for (const c of cards) {
      expect(c.className).not.toContain("rounded"); // 角丸の枠なし
      expect(c.className).not.toMatch(/(^|\s)border(\s|$)/);
      expect(c.querySelector("dt")!.textContent).toBeTruthy(); // 項目名
      expect(c.querySelector("dd")).not.toBeNull(); // 日時
    }
    const rows = Math.ceil(cards.length / 2);
    cards.forEach((c, i) => expect(c.className.includes("border-b")).toBe(Math.floor(i / 2) < rows - 1)); // 区切り線は行の間だけ
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

  it("上部の応募状態は対象のアプリ内プロフィール全員分（アイコン＋記号だけ。長い文字は出さない）。現在のプロフィールは区別する", () => {
    open("L1");
    const strip = q("status-strip")!;
    const items = [...strip.querySelectorAll<HTMLElement>("[data-profile]")];
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(strip.textContent).not.toMatch(/応募不可|未応募|応募済み|スルー/); // 長い文字列は上部に出さない
    // 並びはプロフィールの設定順
    const order = data.profiles.map((p) => p.id);
    const ids = items.map((i) => i.getAttribute("data-profile")!);
    expect(ids).toEqual([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(items.filter((i) => i.getAttribute("data-mine") === "1")).toHaveLength(1);
  });

  it("開始前の抽選は「応募不可」と表示せず「受付前」。受付中・受付終了も抽選の日時で判定し、日時が不明なら断定しない", async () => {
    const { receptionState, markLabel } = await import("@/lib/lottery-summary");
    const base = data.lotteries.find((x) => x.id === "L1")!;
    const L = (p: Partial<Lottery>) => ({ ...base, eventState: "open", ...p }) as Lottery;
    const future = { precision: "date_only", date: "2026-11-20" } as const;
    const past = { precision: "date_only", date: "2026-10-20" } as const;
    expect(receptionState(L({ applyStart: future, applyDeadline: { precision: "date_only", date: "2026-11-30" } }), NOW)).toBe("受付前");
    expect(receptionState(L({ applyStart: past, applyDeadline: { precision: "date_only", date: "2026-11-30" } }), NOW)).toBe("受付中");
    expect(receptionState(L({ applyStart: past, applyDeadline: past }), NOW)).toBe("受付終了");
    expect(receptionState(L({ applyStart: { precision: "unknown" }, applyDeadline: { precision: "unknown" } }), NOW)).toBeNull(); // 推測しない
    expect(receptionState(L({ eventState: "cancelled" }), NOW)).toBe("中止");
    // プロフィールの応募状況の文言: 受付前・受付終了・中止は状態名。条件によって応募できないときだけ「応募不可」
    expect(markLabel({ status: "unavailable", result: "none" as never, partial: false, reason: "受付前" })).toBe("受付前");
    expect(markLabel({ status: "unavailable", result: "none" as never, partial: false, reason: "受付終了" })).toBe("受付終了");
    expect(markLabel({ status: "unavailable", result: "none" as never, partial: false, reason: "その他の理由" })).toBe("応募不可");
  });

  it("ステータス行の左には抽選の受付状態（受付前など）が出る。判定の詳細でも開始前を「応募不可」と表示しない", () => {
    patch("L1", { applyStart: { precision: "date_only", date: "2026-11-20" } } as Partial<Lottery>);
    open("L1");
    expect(q("reception-chip")!.textContent).toBe("受付前");
    expect(q("judge-list")!.textContent).not.toContain("応募不可");
    expect(q("judge-list")!.textContent).toContain("受付前");
  });

  it("ステータス行は1行: 左=抽選の状態、右=全プロフィールの応募状態", () => {
    const l = data.lotteries.find((x) => x.id === "L1")!;
    const mine = data.accounts.find((a) => a.profileId === data.profiles[0].id)!;
    const app: Application = { id: "app-x", lotteryId: l.id, accountId: mine.id, state: "applied", result: "pending", fulfillment: "none", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } as unknown as Application;
    data = { ...data, applications: [...data.applications.filter((a) => !(a.lotteryId === l.id && a.accountId === mine.id)), app] };
    open("L1");
    const line = q("status-line")!;
    expect(line.className).toContain("flex");
    expect(line.className).not.toContain("flex-wrap"); // 2行にしない
    expect(line.querySelector('[data-testid="status-left"]')!.className).toContain("flex-nowrap");
    expect(q("status-strip")!.querySelector(`[data-profile="${data.profiles[0].id}"]`)!.getAttribute("data-status")).toBe("applied");
    // 別のプロフィールを選ぶと、そのプロフィールが「現在」の印になる
    act(() => root.unmount());
    root = createRoot(host);
    profileIdx = 1;
    open("L1");
    expect(q("status-strip")!.querySelector('[data-mine="1"]')!.getAttribute("data-profile")).toBe(data.profiles[1].id);
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
    patch("L1", { sourceUrls: ["https://example.invalid/a"], resultDate: { precision: "unknown" }, cautions: [{ code: "result_date_unknown", field: "resultDate", message: "当選発表日が確認できていません", at: NOW.toISOString() }] } as Partial<Lottery>);
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
