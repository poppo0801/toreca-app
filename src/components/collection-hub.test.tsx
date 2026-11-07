import { act, createElement, useImperativeHandle, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: string[] = [];
let search = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search) }));
vi.mock("@/lib/data-source", () => ({ IS_SUPABASE_MODE: true }));
vi.mock("@/components/page-heading", () => ({ PAGE_HEADING_ROW: "row", PageHeading: ({ children }: { children: string }) => createElement("h1", null, children) }));
vi.mock("@/components/collection-view", () => ({
  CollectionView: ({ ref }: { ref?: Ref<{ openRegister: () => void; openMarket: () => void }> }) => {
    useImperativeHandle(ref, () => ({ openRegister: () => void calls.push("card:register"), openMarket: () => void calls.push("card:market") }), []);
    return createElement("div", { "data-testid": "card-content" }, createElement("input", { "aria-label": "検索" }), "カード一覧");
  },
}));
vi.mock("@/components/box-collection-view", () => ({
  BoxCollectionPanel: ({ ref }: { ref?: Ref<{ openRegister: () => void; openPrices: () => void }> }) => {
    useImperativeHandle(ref, () => ({ openRegister: () => void calls.push("box:register"), openPrices: () => void calls.push("box:prices") }), []);
    return createElement("div", { "data-testid": "box-content" }, "BOX一覧");
  },
}));

import { CollectionHub } from "@/components/collection-hub";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  calls.length = 0;
  search = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(CollectionHub)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const tab = () => q("collection-hub").getAttribute("data-tab");
/** タッチ操作（開始→終了）。touches は React の synthetic event が読む形で渡す */
function swipe(from: [number, number], to: [number, number], target: Element = q("collection-swipe")) {
  const fire = (type: string, p: [number, number], list: "touches" | "changedTouches") => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    const t = [{ clientX: p[0], clientY: p[1] }];
    Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : t });
    Object.defineProperty(e, "changedTouches", { value: t });
    void list;
    target.dispatchEvent(e);
  };
  act(() => {
    fire("touchstart", from, "touches");
    fire("touchend", to, "changedTouches");
  });
}

describe("コレクションのカード／BOX切替", () => {
  it("初期はカード。タブのタップで切り替わる（BOXのページだけが操作対象になる）", () => {
    expect(tab()).toBe("card");
    act(() => q("collection-tab-box").click());
    expect(tab()).toBe("box");
    expect(q("collection-tab-box").getAttribute("aria-selected")).toBe("true");
    expect(q("collection-panel-card").getAttribute("aria-hidden")).toBe("true");
    expect(q("collection-panel-box").getAttribute("aria-hidden")).toBe("false");
    act(() => q("collection-tab-card").click());
    expect(tab()).toBe("card");
  });
  it("左右のスワイプで切り替わる。向きが合わないスワイプは何も起きない", () => {
    swipe([300, 200], [150, 205]); // 左へ → BOX
    expect(tab()).toBe("box");
    swipe([300, 200], [150, 205]); // BOX でさらに左へ → そのまま
    expect(tab()).toBe("box");
    swipe([100, 200], [260, 190]); // 右へ → カード
    expect(tab()).toBe("card");
    swipe([100, 200], [260, 190]); // カードでさらに右へ → そのまま
    expect(tab()).toBe("card");
  });
  it("縦スクロール中心の動きや短い動き、入力欄での操作では切り替わらない", () => {
    swipe([300, 100], [230, 400]); // 縦が大きい
    swipe([300, 200], [270, 200]); // 短い
    expect(tab()).toBe("card");
    swipe([300, 200], [100, 200], host.querySelector("input")!); // 入力欄から
    expect(tab()).toBe("card");
  });
  it("長押しドラッグ（並び替え）の最中のスワイプは切り替えに使わない", () => {
    const e = (type: string, x: number, y: number) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "touches", { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] });
      Object.defineProperty(ev, "changedTouches", { value: [{ clientX: x, clientY: y }] });
      return ev;
    };
    const el = q("collection-swipe");
    const dragging = document.createElement("div");
    dragging.setAttribute("data-dragging", "");
    document.body.appendChild(dragging);
    act(() => {
      el.dispatchEvent(e("touchstart", 300, 200));
      el.dispatchEvent(e("touchmove", 250, 200));
      el.dispatchEvent(e("touchend", 100, 200));
    });
    dragging.remove();
    expect(tab()).toBe("card");
  });
  it("右上の［相場更新］［登録］は表示中のページに対して働く。登録ボタンの名称は「登録」", () => {
    expect(q("add-card").textContent).toBe("登録");
    act(() => q("add-card").click());
    act(() => q("market-update-open").click());
    act(() => q("collection-tab-box").click());
    act(() => q("add-card").click());
    act(() => q("market-update-open").click());
    expect(calls).toEqual(["card:register", "card:market", "box:register", "box:prices"]);
  });
  it("URL の tab=box で BOX を開いた状態から始まる。切替後はURLに反映する", () => {
    act(() => root.unmount());
    search = "tab=box";
    root = createRoot(host);
    act(() => root.render(createElement(CollectionHub)));
    expect(tab()).toBe("box");
    act(() => q("collection-tab-card").click());
    expect(window.location.search).not.toContain("tab=box");
    act(() => q("collection-tab-box").click());
    expect(window.location.search).toContain("tab=box");
  });
  it("切替アニメーションのあと、非表示のページは高さを持たない（スクロール量に影響しない）", () => {
    vi.useFakeTimers();
    act(() => q("collection-tab-box").click());
    expect(q("collection-panel-card").className).not.toContain("h-0");
    act(() => void vi.advanceTimersByTime(400));
    expect(q("collection-panel-card").className).toContain("h-0");
    expect(q("collection-panel-box").className).not.toContain("h-0");
  });
});
