import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAV_ITEMS, navItemsFor } from "@/lib/profile-settings";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }), usePathname: () => "/lotteries" }));

import { MenuButton, NavMenuGrid } from "@/components/nav-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const QUICK = ["masters", "member-numbers", "notifications"].map((id) => NAV_ITEMS.find((n) => n.id === id)!);
let root: Root;
let host: HTMLDivElement;
const onOpenMenu = vi.fn();
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/** ボタン（画面の右下）と、展開後の項目（上へ並ぶ）の位置を決める。jsdom は位置を持たないので差し替える */
const BTN = { left: 300, right: 390, top: 700, bottom: 756, width: 90, height: 56, x: 300, y: 700, toJSON() {} };
const itemBox = (i: number) => ({ left: 200, right: 380, top: 400 + i * 52, bottom: 444 + i * 52, width: 180, height: 44, x: 200, y: 400 + i * 52, toJSON() {} });
const ev = (type: string, x = 340, y = 730) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, "pointerId", { value: 1 });
  Object.defineProperty(e, "pointerType", { value: "touch" });
  return e;
};
const fire = (el: Element, type: string, x?: number, y?: number) => act(async () => void el.dispatchEvent(ev(type, x, y)));

beforeEach(() => {
  vi.useFakeTimers();
  push.mockClear();
  onOpenMenu.mockClear();
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute("data-quick")) return itemBox(QUICK.findIndex((n) => n.id === this.getAttribute("data-quick"))) as DOMRect;
    return BTN as DOMRect;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(MenuButton, { quick: QUICK, active: false, onOpenMenu })));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const btn = () => q("nav-more")!;
const longPress = async () => {
  await fire(btn(), "pointerdown");
  await act(async () => void vi.advanceTimersByTime(450));
};

describe("UI-1: メニューボタン（通常タップと長押しの区別）", () => {
  it("通常のタップ（短い）: 全機能のメニューを開く。ショートカットは出ない", async () => {
    await fire(btn(), "pointerdown");
    await act(async () => void vi.advanceTimersByTime(100));
    await fire(btn(), "pointerup");
    await act(async () => void btn().click());
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(q("quick-menu")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });
  it("長押し: ショートカットが上方向に展開される（項目はアイコン＋名称）。タッチ操作でスクロール・テキスト選択・コンテキストメニューを出さない設定", async () => {
    await longPress();
    const menu = q("quick-menu")!;
    expect(menu).not.toBeNull();
    expect([...menu.querySelectorAll("[data-quick]")].map((e) => e.getAttribute("data-quick"))).toEqual(["masters", "member-numbers", "notifications"]);
    expect(menu.querySelectorAll("svg")).toHaveLength(3);
    expect(btn().className).toContain("touch-none"); // touch-action: none（ドラッグ中にページをスクロールしない）
    expect(btn().className).toContain("select-none");
    const cm = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => void btn().dispatchEvent(cm));
    expect(cm.defaultPrevented).toBe(true);
    await fire(btn(), "pointerup", 340, 100); // 項目の外で離してキャンセル
  });
  it("長押し→上へドラッグ→項目の上で離す: ハイライトされ、その機能へ移動する。直後のclickはメニューを開く操作にならない", async () => {
    await longPress();
    await fire(btn(), "pointermove", 300, 470); // 2番目の項目の位置
    expect(q("quick-menu")!.querySelector('[data-quick="member-numbers"]')!.getAttribute("data-hover")).toBe("true");
    expect(q("quick-menu")!.querySelector('[data-quick="masters"]')!.getAttribute("data-hover")).toBe("false");
    await fire(btn(), "pointerup", 300, 470);
    expect(push).toHaveBeenCalledWith("/settings/member-numbers");
    expect(q("quick-menu")).toBeNull();
    await act(async () => void btn().click());
    expect(onOpenMenu).not.toHaveBeenCalled();
  });
  it("項目の外で指を離したらキャンセル（移動しない・メニューも開かない）", async () => {
    await longPress();
    await fire(btn(), "pointermove", 300, 300);
    await fire(btn(), "pointerup", 300, 300);
    expect(push).not.toHaveBeenCalled();
    expect(q("quick-menu")).toBeNull();
    await act(async () => void btn().click());
    expect(onOpenMenu).not.toHaveBeenCalled();
  });
  it("操作が中断（pointercancel・Escape・画面が隠れる）されたときも、移動せず正常に閉じる", async () => {
    await longPress();
    await fire(btn(), "pointermove", 300, 470);
    await fire(btn(), "pointercancel", 300, 470);
    expect(q("quick-menu")).toBeNull();
    expect(push).not.toHaveBeenCalled();
    await longPress();
    expect(q("quick-menu")).not.toBeNull();
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(q("quick-menu")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });
  it("長押しの成立前に指が大きく動いたら、長押しにならない（スクロール等）", async () => {
    await fire(btn(), "pointerdown", 340, 730);
    await fire(btn(), "pointermove", 340, 680);
    await act(async () => void vi.advanceTimersByTime(600));
    expect(q("quick-menu")).toBeNull();
  });
  it("ショートカットが無い（空）ときは長押しを受け付けず、通常のタップだけ", async () => {
    act(() => root.render(createElement(MenuButton, { quick: [], active: false, onOpenMenu })));
    await fire(btn(), "pointerdown");
    await act(async () => void vi.advanceTimersByTime(600));
    expect(q("quick-menu")).toBeNull();
    await act(async () => void btn().click());
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });
});

describe("UI-1: メニュー画面（全機能のグリッド）", () => {
  it("アイコン＋機能名のグリッドで、渡された（権限で絞られた）機能だけを出す。管理者専用は一般ユーザーの一覧に無い", () => {
    const user = navItemsFor({ isAdmin: false, supabase: true });
    act(() => root.render(createElement(NavMenuGrid, { items: user })));
    const links = [...document.body.querySelectorAll<HTMLAnchorElement>('[data-testid="nav-grid"] a')];
    expect(links.map((a) => a.getAttribute("data-more"))).toEqual(user.map((n) => n.id));
    expect(links.map((a) => a.getAttribute("data-more"))).not.toContain("candidates");
    expect(links.every((a) => a.querySelector("svg") && (a.textContent ?? "").length > 0)).toBe(true);
    expect(links.every((a) => a.className.includes("min-h-[4.5rem]"))).toBe(true); // 押しやすい大きさ
    const admin = navItemsFor({ isAdmin: true, supabase: true });
    act(() => root.render(createElement(NavMenuGrid, { items: admin })));
    expect([...document.body.querySelectorAll('[data-testid="nav-grid"] a')].map((a) => a.getAttribute("data-more"))).toContain("candidates");
  });
});
