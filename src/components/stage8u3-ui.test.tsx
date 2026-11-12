import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { AppData } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
const duplicateLottery = vi.fn();
const lotteryOperationResult = vi.fn();
const reload = vi.fn(async () => data);
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], settings: {}, actions: { duplicateLottery, lotteryOperationResult }, persistent: true, reload }),
}));

import { DuplicateDialog } from "@/components/duplicate-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

beforeEach(() => {
  data = createMockData(NOW);
  duplicateLottery.mockReset();
  lotteryOperationResult.mockReset();
  window.matchMedia = ((qq: string) => ({ matches: false, media: qq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("Stage 8U-3: 他店舗に複製（通信障害・再送）", () => {
  const open = () => {
    const lot = data.lotteries[0];
    act(() => root.render(createElement(DuplicateDialog, { lottery: lot, open: true, onOpenChange: vi.fn() })));
    // 新しい店舗を1件追加して選択済みにする
    const input = q("store-picker-new-name") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "テスト新店舗");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return click(q("store-picker-new-add")!);
  };
  it("通信が途切れ（uncertain）、確認したら保存されていた → 失敗とせず成功として扱う（二重に作らない）", async () => {
    await open();
    duplicateLottery.mockResolvedValueOnce({ ok: false, error: "通信に失敗しました", uncertain: true });
    lotteryOperationResult.mockResolvedValueOnce({ ok: true, found: true, result: { ids: ["n1"] } });
    await click(q("duplicate-submit")!);
    await act(async () => void (await Promise.resolve()));
    expect(lotteryOperationResult).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("通信に失敗しました");
    expect(duplicateLottery).toHaveBeenCalledTimes(1);
  });
  it("通信が途切れ、確認したら保存されていない → 失敗と断定せず「保存されていませんでした」と伝え、再送は同じ操作IDで行う", async () => {
    await open();
    duplicateLottery.mockResolvedValue({ ok: false, error: "通信に失敗しました", uncertain: true });
    lotteryOperationResult.mockResolvedValue({ ok: true, found: false });
    await click(q("duplicate-submit")!);
    await act(async () => void (await Promise.resolve()));
    expect(document.body.textContent).toContain("確認したところ、複製されていませんでした");
    await click(q("duplicate-submit")!);
    await act(async () => void (await Promise.resolve()));
    const ids = duplicateLottery.mock.calls.map((c) => (c[2] as { opId: string }).opId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]); // 同じ内容の再送は同じ操作ID（サーバーが二重作成を防ぐ）
  });
  it("確認もできない（通信が回復していない）→ 「確認できませんでした」と伝え、同じ操作IDで再送できる。内容を変えると新しい操作ID", async () => {
    await open();
    duplicateLottery.mockResolvedValue({ ok: false, error: "通信に失敗しました", uncertain: true });
    lotteryOperationResult.mockResolvedValue({ ok: false, error: "通信に失敗しました" });
    await click(q("duplicate-submit")!);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(document.body.textContent).toContain("確認できませんでした");
    expect(document.body.textContent).toContain("二重には登録されません");
    const first = (duplicateLottery.mock.calls[0][2] as { opId: string }).opId;
    // 店舗を1件追加して内容が変わると、別の操作
    const input = q("store-picker-new-name") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "もう1店舗");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(q("store-picker-new-add")!);
    await click(q("duplicate-submit")!);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect((duplicateLottery.mock.calls[1][2] as { opId: string }).opId).not.toBe(first);
  });
  it("サーバーが失敗（uncertain ではない）と返したら、そのまま失敗を表示して結果確認はしない", async () => {
    await open();
    duplicateLottery.mockResolvedValueOnce({ ok: false, error: "複製先は同じ系列の店舗のみ選択できます" });
    await click(q("duplicate-submit")!);
    expect(document.body.textContent).toContain("同じ系列の店舗のみ");
    expect(lotteryOperationResult).not.toHaveBeenCalled();
  });
  it("連続タップ: 処理中は押せず、複製の呼び出しは1回だけ", async () => {
    await open();
    let release: (v: unknown) => void = () => undefined;
    duplicateLottery.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const btn = q("duplicate-submit") as HTMLButtonElement;
    await click(btn);
    await click(btn);
    await click(btn);
    expect(duplicateLottery).toHaveBeenCalledTimes(1);
    expect((q("duplicate-submit") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release({ ok: true, data, createdIds: ["n1"] }));
  });
});
