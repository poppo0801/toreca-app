import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UndoToastProvider, useUndoToast, type UndoToastInput } from "@/components/undo-toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const out = {} as { show: (t: UndoToastInput) => void };

function Probe() {
  const t = useUndoToast();
  useEffect(() => {
    out.show = t.show;
  });
  return null;
}

beforeEach(() => {
  host = document.createElement("div");
  host.setAttribute("data-testid", "scroll-area");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(UndoToastProvider, null, createElement(Probe))));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("元に戻す通知の表示位置", () => {
  it("スクロール領域の中ではなく body 直下に描画する（固定ヘッダーの裏に隠れて下の端しか見えなくならない）", () => {
    act(() => out.show({ message: "応募済みにしました", undo: async () => true }));
    const wrap = document.querySelector('[data-testid="undo-toast-wrap"]') as HTMLElement;
    expect(wrap).not.toBeNull();
    expect(wrap.parentElement).toBe(document.body);
    expect(host.contains(wrap)).toBe(false);
    expect(wrap.className).toContain("fixed");
    expect(document.querySelector('[data-testid="undo-toast"]')?.textContent).toContain("応募済みにしました");
  });
});
