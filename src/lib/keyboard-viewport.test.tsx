import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";
import { needsViewportReset } from "@/lib/viewport-insets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Stage 7P: キーボードを閉じたあとに残る「ページの押し上げ」（表示位置とタップ判定位置のズレ）の補正 */
describe("needsViewportReset（純粋な判定）", () => {
  const vv = (o: Partial<{ offsetTop: number; offsetLeft: number; scale: number }> = {}) => ({ offsetTop: 0, offsetLeft: 0, scale: 1, ...o });
  it("ページが 0 の位置にあれば不要", () => {
    expect(needsViewportReset({ editing: false, scrollX: 0, scrollY: 0, vv: vv() })).toBe(false);
    expect(needsViewportReset({ editing: false, scrollX: 0, scrollY: 0, vv: null })).toBe(false);
  });
  it("入力中（キーボード表示中）は、入力欄を見せるための押し上げなので戻さない", () => {
    expect(needsViewportReset({ editing: true, scrollX: 0, scrollY: 120, vv: vv({ offsetTop: 120 }) })).toBe(false);
  });
  it("入力中でないのにページが押し上がったまま（scrollY / offsetTop / 横ずれ）なら戻す", () => {
    expect(needsViewportReset({ editing: false, scrollX: 0, scrollY: 80, vv: vv() })).toBe(true);
    expect(needsViewportReset({ editing: false, scrollX: 0, scrollY: 0, vv: vv({ offsetTop: 60 }) })).toBe(true);
    expect(needsViewportReset({ editing: false, scrollX: 12, scrollY: 0, vv: vv() })).toBe(true);
    expect(needsViewportReset({ editing: false, scrollX: 0, scrollY: 0, vv: vv({ offsetLeft: 5 }) })).toBe(true);
  });
  it("ピンチ拡大中は触らない・1px未満の誤差は無視", () => {
    expect(needsViewportReset({ editing: false, scrollX: 0, scrollY: 80, vv: vv({ scale: 2 }) })).toBe(false);
    expect(needsViewportReset({ editing: false, scrollX: 0, scrollY: 0.4, vv: vv({ offsetTop: 0.3 }) })).toBe(false);
  });
});

class FakeVV extends EventTarget {
  height = 800;
  offsetTop = 0;
  offsetLeft = 0;
  scale = 1;
}

describe("useKeyboardInset: キーボードの開閉", () => {
  let root: Root;
  let host: HTMLElement;
  let vv: FakeVV;
  let scrollTo: ReturnType<typeof vi.fn>;
  let input: HTMLInputElement;
  const orig = { vv: Object.getOwnPropertyDescriptor(window, "visualViewport"), scrollTo: window.scrollTo, innerHeight: window.innerHeight };

  function Probe() {
    useKeyboardInset();
    return null;
  }
  const setScroll = (y: number) => Object.defineProperty(window, "scrollY", { value: y, configurable: true });

  beforeEach(() => {
    vi.useFakeTimers();
    vv = new FakeVV();
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    scrollTo = vi.fn();
    window.scrollTo = scrollTo as never;
    setScroll(0);
    host = document.createElement("div");
    document.body.appendChild(host);
    input = document.createElement("input");
    document.body.appendChild(input);
    root = createRoot(host);
    act(() => root.render(createElement(Probe)));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    input.remove();
    vi.useRealTimers();
    if (orig.vv) Object.defineProperty(window, "visualViewport", orig.vv);
    window.scrollTo = orig.scrollTo;
    Object.defineProperty(window, "innerHeight", { value: orig.innerHeight, configurable: true });
    setScroll(0);
  });

  const openKeyboard = () => {
    input.focus();
    vv.height = 450; // キーボード分だけ見える領域が縮む
    vv.offsetTop = 120; // iOS が入力欄を見せるためにページを押し上げる
    setScroll(120);
    window.dispatchEvent(new Event("focusin"));
    vv.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(700);
  };
  const closeKeyboard = (restoreOffset: boolean) => {
    input.blur();
    vv.height = 800;
    if (restoreOffset) {
      vv.offsetTop = 0;
      setScroll(0);
    }
    window.dispatchEvent(new Event("focusout"));
    vv.dispatchEvent(new Event("resize"));
  };

  it("キーボード表示中は --kb-inset を設定し、ページを動かさない", () => {
    openKeyboard();
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).not.toBe("");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("キーボードを閉じたあと押し上げが残ったら、ページの位置を 0 へ戻し、--kb-inset を外す（表示位置とタップ判定位置が一致）", () => {
    openKeyboard();
    closeKeyboard(false); // iOS が押し上げを戻さない状態
    vi.advanceTimersByTime(1000);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("");
  });

  it("iOS が自分で元に戻したときは、何もしない（余計なスクロールをしない）", () => {
    openKeyboard();
    closeKeyboard(true);
    vi.advanceTimersByTime(1000);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("入力欄から別の入力欄へ移るだけ（focusout のあとすぐ focusin）のときは、ページを戻さない", () => {
    openKeyboard();
    const other = document.createElement("input");
    document.body.appendChild(other);
    input.blur();
    window.dispatchEvent(new Event("focusout"));
    other.focus();
    window.dispatchEvent(new Event("focusin"));
    vi.advanceTimersByTime(1000);
    expect(scrollTo).not.toHaveBeenCalled();
    other.remove();
  });

  it("入力欄にフォーカスが残っていても、キーボードが出ていなければ（スワイプで閉じた）押し上げを戻す", () => {
    openKeyboard();
    vv.height = 800; // キーボードだけが閉じ、フォーカスは残る
    vv.dispatchEvent(new Event("resize"));
    expect(document.activeElement).toBe(input);
    vv.dispatchEvent(new Event("scroll"));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("繰り返し開閉しても毎回正常に戻り、アンマウントでタイマー・リスナーを残さない", () => {
    for (let i = 0; i < 5; i++) {
      scrollTo.mockClear();
      openKeyboard();
      closeKeyboard(false);
      vi.advanceTimersByTime(1000);
      expect(scrollTo).toHaveBeenCalledWith(0, 0);
      setScroll(0);
      vv.offsetTop = 0;
    }
    act(() => root.unmount());
    scrollTo.mockClear();
    vv.offsetTop = 50;
    vv.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("focusout"));
    vi.advanceTimersByTime(2000);
    expect(scrollTo).not.toHaveBeenCalled();
    root = createRoot(host); // afterEach の unmount 用
  });
});
