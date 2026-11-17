import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { AppData, Lottery } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
const seen = vi.fn(async (_id: string): Promise<{ ok: boolean }> => ({ ok: true }));
const setApplied = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data }));
const reload = vi.fn(async () => {});
const actions = new Proxy({ setApplied } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : vi.fn(async () => ({ ok: true, data }))) });
vi.mock("next/navigation", () => ({ usePathname: () => "/lotteries", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], settings: {}, actions, persistent: true, reload }),
}));
vi.mock("@/app/(app)/lotteries/actions", () => ({ acknowledgeCautionsAction: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/lotteries/seen-actions", () => ({ markLotterySeen: (id: string) => seen(id) }));
vi.mock("@/app/(app)/settings/rules/actions", () => ({ addSkipRuleAction: vi.fn(), removeSkipRuleAction: vi.fn(), setLimitExemptionAction: vi.fn(), setSkipExceptionAction: vi.fn() }));
vi.mock("@/components/lottery-form", () => ({ LotteryFormDialog: () => null }));
vi.mock("@/components/duplicate-dialog", () => ({ DuplicateDialog: () => null }));
vi.mock("@/components/ongoing-ops", () => ({ OngoingOps: () => null }));
vi.mock("@/components/past-apply-recorder", () => ({ PastApplyRecorder: () => null }));

import { LotteryDetailSheet } from "@/components/lottery-detail-sheet";
import { LotteryCard } from "@/components/lottery-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const lot = (): Lottery => ({ ...data.lotteries[0], isNew: true });

beforeEach(() => {
  data = createMockData(NOW);
  seen.mockClear();
  setApplied.mockClear();
  window.matchMedia = ((qq: string) => ({ matches: false, media: qq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("UI-1: NEWの既読は詳細を閉じた時点（開いた時点では解除しない）", () => {
  const mount = (open: boolean, onOpenChange = vi.fn()) => act(async () => root.render(createElement(LotteryDetailSheet, { lottery: lot(), open, onOpenChange })));

  it("開いただけでは既読にしない。閉じる操作（onOpenChange(false)）で1回だけ既読にする", async () => {
    const onOpenChange = vi.fn();
    await mount(true, onOpenChange);
    await flush();
    expect(seen).not.toHaveBeenCalled();
    // 閉じるボタン（ダイアログの閉じる操作）
    const close = document.body.querySelector<HTMLElement>('[aria-label="閉じる"], [data-testid="sheet-close"]');
    if (close) await act(async () => void close.click());
    else await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(lot().id);
  });
  it("親が open を false にして閉じた場合（戻る操作など）も、閉じた時点で既読にする。二重には呼ばない", async () => {
    await mount(true);
    await flush();
    expect(seen).not.toHaveBeenCalled();
    await mount(false);
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);
    await mount(false);
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);
  });
  it("閉じずに画面が破棄された（別画面への遷移でアンマウント）だけでは既読にしない", async () => {
    await mount(true);
    await flush();
    await act(async () => root.render(createElement("div")));
    await flush();
    expect(seen).not.toHaveBeenCalled();
  });
  it("通信エラー（失敗・例外）のときは既読にせず、再読み込みもしない（NEWが残る）", async () => {
    seen.mockResolvedValueOnce({ ok: false });
    await mount(true);
    await mount(false);
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    seen.mockRejectedValueOnce(new Error("network"));
    await mount(true);
    await mount(false);
    await flush();
    expect(seen).toHaveBeenCalledTimes(2); // 例外でも画面が壊れない
  });
  it("NEWでない抽選は既読処理をしない", async () => {
    await act(async () => root.render(createElement(LotteryDetailSheet, { lottery: { ...data.lotteries[0], isNew: false }, open: true, onOpenChange: vi.fn() })));
    await act(async () => root.render(createElement(LotteryDetailSheet, { lottery: { ...data.lotteries[0], isNew: false }, open: false, onOpenChange: vi.fn() })));
    await flush();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("UI-1: NEW表示は小さな●（大きなバッジを使わない）", () => {
  it("カード右上の角に●を出す（操作を受けない）。NEWの文字は読み上げ用だけ。既読（isNew=false）では出ない", async () => {
    await act(async () => root.render(createElement(LotteryCard, { lottery: lot() })));
    const dot = q("new-dot")!;
    expect(dot).not.toBeNull();
    expect(dot.className).toContain("pointer-events-none");
    expect(dot.className).toContain("-right-1");
    expect(dot.className).toContain("-top-1");
    expect(dot.querySelector(".sr-only")?.textContent).toBe("NEW");
    expect(document.body.querySelector('[data-testid="lottery-card"] .border-info.text-info')?.textContent ?? "").not.toBe("NEW"); // 旧チップなし
    await act(async () => root.render(createElement(LotteryCard, { lottery: { ...lot(), isNew: false } })));
    expect(q("new-dot")).toBeNull();
  });
});

describe("UI-1: シンプル表示の応募ボタン", () => {
  it("未応募は「応募」ボタン。タップで既存の応募処理を1回だけ呼び、カード全体のタップ（詳細を開く）に伝えない。処理中の二重タップは無効", async () => {
    let resolve!: (v: { ok: true; data: AppData }) => void;
    setApplied.mockImplementationOnce(() => new Promise((r) => (resolve = r as never)));
    await act(async () => root.render(createElement(LotteryCard, { lottery: { ...data.lotteries.find((l) => l.id === "L4")!, isNew: false } })));
    const btn = q("my-apply") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("応募");
    expect(btn.getAttribute("data-state")).toBe("unapplied");
    await act(async () => void btn.click());
    await act(async () => void btn.click()); // 二重タップ
    expect(q("lottery-detail")).toBeNull(); // カード全体のタップ（詳細を開く）に伝わらない
    expect(setApplied).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ok: true, data }));
  });
});
