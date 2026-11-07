import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CountInput, parseCount } from "@/components/count-input";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const out = { latest: -1 };

function Probe({ initial = 3 }: { initial?: number }) {
  const [v, setV] = useState(initial);
  useEffect(() => {
    out.latest = v;
  });
  return createElement(CountInput, { "aria-label": "数量", value: v, onChange: setV });
}
// React の制御 input は native setter 経由で値を入れて input イベントを送る
function type(el: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const input = () => host.querySelector("input") as HTMLInputElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Probe)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("数量の入力欄", () => {
  it("数字を全部消して空欄にでき、そのまま別の数字を入力できる（即座に0へ変わらない）", () => {
    expect(input().value).toBe("3");
    type(input(), "");
    expect(input().value).toBe(""); // 空欄のまま
    type(input(), "5");
    expect(input().value).toBe("5");
    expect(out.latest).toBe(5);
  });
  it("フォーカスが外れたとき、空欄なら0にする", () => {
    type(input(), "");
    expect(out.latest).toBe(0); // 保存時の検証は 0 を「数量は1以上」として拒否できる
    act(() => void input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(input().value).toBe("0");
  });
  it("負数・小数・数字以外は入力できない。スマホでは数字キーボード", () => {
    type(input(), "-4");
    expect(input().value).toBe("4");
    type(input(), "2.5");
    expect(input().value).toBe("25");
    type(input(), "abc");
    expect(input().value).toBe("");
    expect(input().inputMode).toBe("numeric");
  });
  it("全角数字は半角にし、上限を超える値は上限にする", () => {
    expect(parseCount("１２")).toBe(12);
    expect(parseCount("99999", 9999)).toBe(9999);
    expect(parseCount("   ")).toBeNull();
  });
});
