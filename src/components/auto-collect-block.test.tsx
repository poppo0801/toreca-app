import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Block } from "@/components/auto-collect-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function Input() {
  const [v, setV] = useState("");
  return createElement("input", { "data-testid": "field", value: v, onChange: (e: { target: { value: string } }) => setV(e.target.value) });
}

describe("自動収集設定の折りたたみ区画", () => {
  it("①は初期状態で展開、それ以外は閉じている。見出しのタップで開閉する", () => {
    act(() => root.render(createElement("div", null, createElement(Block, { no: "①", title: "動作状況", testId: "status", defaultOpen: true }, "A"), createElement(Block, { no: "②", title: "条件", testId: "conditions" }, "B"))));
    expect(q("status")!.dataset.open).toBe("true");
    expect(q("conditions")!.dataset.open).toBe("false");
    expect(q("conditions-toggle")!.getAttribute("aria-expanded")).toBe("false");
    act(() => q("conditions-toggle")!.click());
    expect(q("conditions")!.dataset.open).toBe("true");
    act(() => q("status-toggle")!.click());
    expect(q("status")!.dataset.open).toBe("false");
  });
  it("閉じていても中身は保持する（入力途中の設定が消えない）", () => {
    act(() => root.render(createElement(Block, { no: "②", title: "条件", testId: "conditions", defaultOpen: true }, createElement(Input))));
    const input = q("field") as HTMLInputElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "入力中");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => q("conditions-toggle")!.click()); // 閉じる
    expect(host.querySelector<HTMLElement>("#conditions-body")!.hidden).toBe(true);
    act(() => q("conditions-toggle")!.click()); // 開く
    expect((q("field") as HTMLInputElement).value).toBe("入力中");
  });
  it("閉じている間は概要と重大な問題を見出しに出す。開くと概要は出さない", () => {
    act(() => root.render(createElement(Block, { no: "③", title: "AI", testId: "run-settings", summary: "今日のAI 100/100件", alert: "本日の上限に到達" }, "x")));
    expect(q("run-settings-summary")!.textContent).toBe("今日のAI 100/100件");
    expect(q("run-settings-alert")!.textContent).toContain("本日の上限に到達");
    act(() => q("run-settings-toggle")!.click());
    expect(q("run-settings-summary")).toBeNull();
  });
  it("forceOpen（#history などの指定）で開いて表示する", () => {
    act(() => root.render(createElement(Block, { no: "④", title: "統計", testId: "history", forceOpen: true }, "x")));
    expect(q("history")!.dataset.open).toBe("true");
  });
});
