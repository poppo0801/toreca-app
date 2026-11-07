import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetShineState, useDragReorder } from "@/components/use-drag-reorder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});
const mount = (el: React.ReactElement) => {
  root = createRoot(host);
  act(() => root!.render(el));
};
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;

function List({ onDrop }: { onDrop: (ids: string[]) => void }) {
  const [ids, setIds] = useState(["a", "b", "c"]);
  const drag = useDragReorder({ enabled: true, ids, onMove: setIds, onDrop, longPressMs: 50 });
  return createElement("ul", { "data-testid": "list" }, ids.map((id) => createElement("li", { key: id, ...drag.bind(id), "data-testid": `it-${id}`, className: "card-shine" }, id)));
}
const pev = (type: string, x: number, y: number) => new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "touch" });
const tev = (type: string, x: number, y: number) => {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: { clientX: number; clientY: number }[] };
  e.touches = type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }];
  return e;
};
const rect = (el: Element, top: number) => (el.getBoundingClientRect = () => ({ x: 0, y: top, left: 0, top, right: 100, bottom: top + 40, width: 100, height: 40, toJSON: () => ({}) }));

describe("Stage 6P: iPhoneの長押しドラッグ（上限なしの長押し・pointercancelで解除しない）", () => {
  it("とても長く押し続けてもドラッグが始まり、指を離すまで維持される", async () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    mount(createElement(List, { onDrop }));
    const a = q('[data-testid="it-a"]')!;
    act(() => void a.dispatchEvent(pev("pointerdown", 10, 10)));
    await act(async () => void vi.advanceTimersByTime(60_000)); // 1分押し続ける
    expect(a.hasAttribute("data-dragging")).toBe(true);
    act(() => void window.dispatchEvent(tev("touchend", 10, 10)));
    expect(a.hasAttribute("data-dragging")).toBe(false);
  });
  it("ドラッグ中に iOS が pointercancel を送っても解除せず、touchmove で追従し、touchend で確定する", async () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    mount(createElement(List, { onDrop }));
    ["a", "b", "c"].forEach((id, i) => rect(q(`[data-testid="it-${id}"]`)!, i * 40));
    const a = q('[data-testid="it-a"]')!;
    act(() => void a.dispatchEvent(pev("pointerdown", 10, 10)));
    await act(async () => void vi.advanceTimersByTime(100));
    expect(a.hasAttribute("data-dragging")).toBe(true);
    act(() => void window.dispatchEvent(pev("pointercancel", 10, 10)));
    expect(a.hasAttribute("data-dragging")).toBe(true); // 解除されない
    act(() => void window.dispatchEvent(tev("touchmove", 10, 50))); // 以後は touchmove で追従（b の位置）
    act(() => void window.dispatchEvent(tev("touchend", 10, 50)));
    expect(a.hasAttribute("data-dragging")).toBe(false);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][0]).toEqual(["b", "a", "c"]);
  });
  it("長押しの前の pointercancel（縦スクロールの開始）では、ドラッグしない", async () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    mount(createElement(List, { onDrop }));
    const a = q('[data-testid="it-a"]')!;
    act(() => void a.dispatchEvent(pev("pointerdown", 10, 10)));
    act(() => void window.dispatchEvent(pev("pointercancel", 10, 10)));
    await act(async () => void vi.advanceTimersByTime(200));
    expect(a.hasAttribute("data-dragging")).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });
  it("touchcancel（指が離れた扱い）でも確定して終了する", async () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    mount(createElement(List, { onDrop }));
    const a = q('[data-testid="it-a"]')!;
    act(() => void a.dispatchEvent(pev("pointerdown", 10, 10)));
    await act(async () => void vi.advanceTimersByTime(100));
    act(() => void window.dispatchEvent(tev("touchcancel", 0, 0)));
    expect(a.hasAttribute("data-dragging")).toBe(false);
  });
});

describe("Stage 6P: 並び替え後の光の演出の復旧", () => {
  it("触れた状態(data-touch)の残りを外し、画面外判定を位置から決め直す", async () => {
    vi.useFakeTimers();
    const ul = document.createElement("ul");
    for (let i = 0; i < 3; i++) {
      const li = document.createElement("li");
      li.className = "card-shine";
      li.dataset.touch = "1";
      li.dataset.offscreen = "1";
      li.getBoundingClientRect = () => ({ x: 0, y: 10 + i * 40, left: 0, top: 10 + i * 40, right: 100, bottom: 50 + i * 40, width: 100, height: 40, toJSON: () => ({}) });
      ul.appendChild(li);
    }
    document.body.appendChild(ul);
    resetShineState(ul);
    for (const li of ul.querySelectorAll<HTMLElement>(".card-shine")) {
      expect(li.dataset.touch).toBeUndefined();
      expect(li.dataset.offscreen).toBe("0"); // 画面内
    }
    ul.remove();
  });
});
