import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveExpense = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean; error?: string });
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data: { stores: [], chains: [], products: [{ id: "pr1", officialName: "テスト弾BOX", code: "", archived: false, aliases: [] }] }, actions: { saveExpense: (...a: unknown[]) => saveExpense(...a) } }),
}));

import { ExpenseDialog } from "@/components/expense-dialog";
import { FilterSheet } from "@/components/lottery-filter-sheet";
import { useDragReorder } from "@/components/use-drag-reorder";
import { DEFAULT_FILTERS } from "@/lib/lottery-view";
import { defaultFiltersFor } from "@/lib/lottery-view";
import { DEFAULT_USER_SCOPE, type UserScopePref } from "@/lib/user-scope";
import { createMockData } from "@/data/mock";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  saveExpense.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = "";
});
const mount = (el: React.ReactElement) => {
  root = createRoot(host);
  act(() => root!.render(el));
};
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.body.querySelectorAll(sel)] as HTMLElement[];
const change = (el: HTMLElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  act(() => {
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};

describe("Stage 6K: 支出登録フォーム", () => {
  it("先頭に品目の選択があり、説明文（購入した商品を登録します…）は出ない", () => {
    mount(createElement(ExpenseDialog, { open: true, onOpenChange: () => undefined, purchase: null }));
    const form = q("form")!;
    expect(form.firstElementChild?.querySelector('[data-testid="expense-category"]')).not.toBeNull();
    expect([...(q('[data-testid="expense-category"]') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["ポケモンカード", "カード周辺グッズ", "経費"]);
    expect(document.body.textContent).not.toContain("購入した商品を登録します");
    expect(document.body.textContent).not.toContain("マスター登録済みの商品は購入実績にも自動で反映されます");
  });
  it("ポケモンカード: 商品マスター・数量・単位・購入方法が出る", () => {
    mount(createElement(ExpenseDialog, { open: true, onOpenChange: () => undefined, purchase: null }));
    expect(q('[aria-label="数量1"]')).not.toBeNull();
    expect(q('[aria-label="単位1"]')).not.toBeNull();
    expect(q('[aria-label="購入方法"]')).not.toBeNull();
    expect(q('[data-testid="expense-item-name"]')).toBeNull();
  });
  it("カード周辺グッズ: 自由入力の品名・数量。単位・購入方法は出さない", () => {
    mount(createElement(ExpenseDialog, { open: true, onOpenChange: () => undefined, purchase: null }));
    change(q('[data-testid="expense-category"]')!, "goods");
    expect(q('[data-testid="expense-item-name"]')).not.toBeNull();
    expect(q('[aria-label="数量1"]')).not.toBeNull();
    expect(q('[aria-label="単位1"]')).toBeNull();
  });
  it("経費: 内容と金額だけ（数量・単位・購入方法は出さない）。保存は品目つき・マスター非連携", async () => {
    mount(createElement(ExpenseDialog, { open: true, onOpenChange: () => undefined, purchase: null }));
    change(q('[data-testid="expense-category"]')!, "expense");
    expect(q('[aria-label="数量1"]')).toBeNull();
    expect(q('[aria-label="単位1"]')).toBeNull();
    expect(q('[aria-label="購入方法"]')).toBeNull();
    change(q('[data-testid="expense-item-name"]')!, "駐車場代");
    change(q('[aria-label="購入金額1"]')!, "800");
    await act(async () => {
      q("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(saveExpense).toHaveBeenCalledTimes(1);
    const input = saveExpense.mock.calls[0][1] as { category: string; channel: string; items: { product: { id: string | null; name: string }; quantity: number; unit: string; amountPaid: number }[] };
    expect(input.category).toBe("expense");
    expect(input.channel).toBe("other");
    expect(input.items[0]).toMatchObject({ product: { id: null, name: "駐車場代" }, quantity: 1, unit: "piece", amountPaid: 800 });
  });
  it("品目を変えても、日付と金額は保たれ、商品だけが引き継がれない", () => {
    mount(createElement(ExpenseDialog, { open: true, onOpenChange: () => undefined, purchase: null }));
    change(q('[aria-label="購入金額1"]')!, "1234");
    change(q('[data-testid="expense-category"]')!, "goods");
    expect((q('[aria-label="購入金額1"]') as HTMLInputElement).value).toBe("1234");
    expect((q('[data-testid="expense-item-name"]') as HTMLInputElement).value).toBe("");
  });
  it("日付入力は幅いっぱいの固定高さ（iOS の日付表示ずれ対策は共通CSS）", () => {
    mount(createElement(ExpenseDialog, { open: true, onOpenChange: () => undefined, purchase: null }));
    const date = q('input[type="date"]')!;
    expect(date.className).toContain("h-11");
    expect(date.className).not.toContain("appearance-none");
  });
});

describe("Stage 6K: 地域の選択画面", () => {
  const data = createMockData(new Date("2026-10-26T03:00:00Z"));
  const open = (applied: { v: string[] }, extra: Partial<React.ComponentProps<typeof FilterSheet>> = {}) =>
    mount(
      createElement(FilterSheet, {
        open: true,
        onOpenChange: () => undefined,
        data,
        filters: { ...DEFAULT_FILTERS, prefectures: ["兵庫県", "大阪府", "京都府"] },
        base: { ...defaultFiltersFor("all"), prefectures: ["兵庫県", "大阪府", "京都府"] },
        tab: "all",
        showSkip: true,
        statusOptions: [{ value: "default", label: "受付中・未応募" }],
        prefectures: [],
        selfId: "pA",
        onApply: (f) => {
          applied.v = f.prefectures;
        },
        ...extra,
      } as React.ComponentProps<typeof FilterSheet>),
    );
  it("既存のプリセット（関西3府県・関西＋関東6都府県・すべて）が残り、地域をタップすると47都道府県の選択画面が開く", () => {
    open({ v: [] });
    expect(["kansai3", "kanto6", "all"].every((m) => q(`[data-testid="f-region-${m}"]`))).toBe(true);
    act(() => q('[data-testid="f-region-open"]')!.click());
    const boxes = qa('[data-testid="f-pref"] input[type="checkbox"]');
    expect(boxes).toHaveLength(47);
    const labels = qa('[data-testid="f-pref"] label').map((l) => l.textContent);
    expect(labels).toContain("神奈川県");
    expect(labels).toContain("北海道");
    expect(labels).toContain("沖縄県");
    expect(qa('[data-testid="f-pref"] h3').map((h) => h.textContent)).toEqual(["北海道・東北", "関東", "中部", "近畿", "中国・四国", "九州・沖縄"]);
  });
  it("複数選択: 神奈川県を追加できる。選択状態は件数で表示される", () => {
    const applied = { v: [] as string[] };
    open(applied);
    act(() => q('[data-testid="f-region-open"]')!.click());
    expect(q('[data-testid="pref-count"]')!.textContent).toContain("3 / 47");
    const kanagawa = qa('[data-testid="f-pref"] label').find((l) => l.textContent === "神奈川県")!.querySelector("input") as HTMLInputElement;
    act(() => kanagawa.click());
    expect(q('[data-testid="pref-count"]')!.textContent).toContain("4 / 47");
    act(() => q('[data-testid="pref-done"]')!.click());
    act(() => q('[data-testid="filter-apply"]')!.click());
    expect(applied.v).toContain("神奈川県");
    expect(applied.v).toHaveLength(4);
  });
  it("すべて選択・選択解除", () => {
    const applied = { v: ["x"] };
    open(applied);
    act(() => q('[data-testid="f-region-open"]')!.click());
    act(() => q('[data-testid="pref-none"]')!.click());
    expect(qa('[data-testid="f-pref"] input[type="checkbox"]').every((b) => !(b as HTMLInputElement).checked)).toBe(true);
    act(() => q('[data-testid="pref-all"]')!.click());
    expect(qa('[data-testid="f-pref"] input[type="checkbox"]').every((b) => (b as HTMLInputElement).checked)).toBe(true);
    expect(q('[data-testid="pref-count"]')!.textContent).toContain("すべて");
  });
  it("応募済み・当選タブにだけ対象ユーザーの選択が出る（既定は自分＋紐づくサブ）", () => {
    const calls: UserScopePref[] = [];
    open({ v: [] }, { tab: "applied", userScope: DEFAULT_USER_SCOPE, onUserScope: (v) => calls.push(v) });
    expect(q('[data-testid="f-user-scope"]')).not.toBeNull();
    expect(q('[data-testid="f-user-linked"]')!.getAttribute("aria-pressed")).toBe("true");
    act(() => q('[data-testid="f-user-all"]')!.click());
    act(() => q('[data-testid="filter-apply"]')!.click());
    expect(calls).toEqual([{ mode: "all", ids: [] }]);
  });
  it("全情報タブには対象ユーザーの選択を出さない", () => {
    open({ v: [] }, { tab: "all", userScope: DEFAULT_USER_SCOPE, onUserScope: () => undefined });
    expect(q('[data-testid="f-user-scope"]')).toBeNull();
  });
});

describe("Stage 6K: 長押しドラッグ並び替え", () => {
  function List({ onDrop, initial = ["a", "b", "c"] }: { onDrop: (ids: string[]) => void; initial?: string[] }) {
    const [ids, setIds] = useState(initial);
    const drag = useDragReorder({ enabled: true, ids, onMove: setIds, onDrop, longPressMs: 50 });
    return createElement("ul", { "data-testid": "list" }, ids.map((id) => createElement("li", { key: id, ...drag.bind(id), "data-testid": `it-${id}` }, id)));
  }
  const ev = (type: string, x: number, y: number) => new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "touch" });
  const rect = (el: Element, top: number) => (el.getBoundingClientRect = () => ({ x: 0, y: top, left: 0, top, right: 100, bottom: top + 40, width: 100, height: 40, toJSON: () => ({}) }));

  it("長押しの前に指が動いたら（縦スクロール）ドラッグしない", async () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    mount(createElement(List, { onDrop }));
    const a = q('[data-testid="it-a"]')!;
    act(() => void a.dispatchEvent(ev("pointerdown", 10, 10)));
    act(() => void window.dispatchEvent(ev("pointermove", 10, 60)));
    await act(async () => void vi.advanceTimersByTime(200));
    act(() => void window.dispatchEvent(ev("pointerup", 10, 60)));
    expect(a.hasAttribute("data-dragging")).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("長押しでドラッグが始まり、重なった項目の位置に入れ替わり、離すと確定する", async () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    mount(createElement(List, { onDrop }));
    ["a", "b", "c"].forEach((id, i) => rect(q(`[data-testid="it-${id}"]`)!, i * 40));
    const a = q('[data-testid="it-a"]')!;
    const b = q('[data-testid="it-b"]')!;
    void b;
    act(() => void a.dispatchEvent(ev("pointerdown", 10, 10)));
    await act(async () => void vi.advanceTimersByTime(80));
    expect(a.getAttribute("data-dragging")).toBe("1");
    act(() => void window.dispatchEvent(ev("pointermove", 12, 55)));
    expect(qa("li").map((l) => l.textContent)).toEqual(["b", "a", "c"]);
    act(() => void window.dispatchEvent(ev("pointerup", 12, 55)));
    expect(onDrop).toHaveBeenCalledWith(["b", "a", "c"]);
    expect(a.hasAttribute("data-dragging")).toBe(false);
    vi.useRealTimers();
  });
  it("入れ替わった直後のカードが移動のアニメーション中で指の下に残っていても、すぐ入れ替え直さない（行ったり来たりしない）", async () => {
    vi.useFakeTimers();
    const onMoves: string[][] = [];
    function Spy() {
      const [ids, setIds] = useState(["a", "b", "c"]);
      const drag = useDragReorder({ enabled: true, ids, onMove: (n) => { onMoves.push(n); setIds(n); }, onDrop: () => undefined, longPressMs: 50 });
      return createElement("ul", { "data-testid": "list" }, ids.map((id) => createElement("li", { key: id, ...drag.bind(id), "data-testid": `it-${id}` }, id)));
    }
    // jsdom には DOMMatrix が無いので、translate(x, y) だけ読める代用品を使う
    class FakeMatrix { m41 = 0; m42 = 0; constructor(t: string) { const m = /translate(([-d.]+)px,s*([-d.]+)px)/.exec(t); if (m) { this.m41 = Number(m[1]); this.m42 = Number(m[2]); } } }
    (globalThis as { DOMMatrix?: unknown }).DOMMatrix = FakeMatrix;
    mount(createElement(Spy));
    const [a, b] = ["a", "b"].map((id) => q(`[data-testid="it-${id}"]`)!);
    // b の見た目の位置はまだ指の下（top 40）。あるべき位置は top 0（translate(0px, 40px) 分だけずれている）
    ["a", "b", "c"].forEach((id, i) => rect(q(`[data-testid="it-${id}"]`)!, i * 40));
    act(() => void a.dispatchEvent(ev("pointerdown", 10, 10)));
    await act(async () => void vi.advanceTimersByTime(80));
    act(() => void window.dispatchEvent(ev("pointermove", 12, 55))); // b の上へ → 入れ替わる
    expect(onMoves).toHaveLength(1);
    // 入れ替え後: b のあるべき位置は top 0。見た目は translate で top 40 に残っている
    rect(b, 40);
    b.style.transform = "translate(0px, 40px)";
    rect(a, 0);
    act(() => void window.dispatchEvent(ev("pointermove", 12, 56)));
    act(() => void window.dispatchEvent(ev("pointermove", 12, 57)));
    expect(onMoves).toHaveLength(1); // 見た目の位置の b に反応して入れ替え直さない
    act(() => void window.dispatchEvent(ev("pointerup", 12, 57)));
    delete (globalThis as { DOMMatrix?: unknown }).DOMMatrix;
    vi.useRealTimers();
  });
  it("ドラッグ直後のクリック（詳細表示）は止める", async () => {
    vi.useFakeTimers();
    mount(createElement(List, { onDrop: () => undefined }));
    const a = q('[data-testid="it-a"]')!;
    const click = vi.fn();
    a.addEventListener("click", click);
    act(() => void a.dispatchEvent(ev("pointerdown", 10, 10)));
    await act(async () => void vi.advanceTimersByTime(80));
    act(() => void window.dispatchEvent(ev("pointerup", 10, 10)));
    act(() => void a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(click).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("通常のタップ（長押しにならない）は何もしない", async () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    mount(createElement(List, { onDrop }));
    const a = q('[data-testid="it-a"]')!;
    const click = vi.fn();
    a.addEventListener("click", click);
    act(() => void a.dispatchEvent(ev("pointerdown", 10, 10)));
    act(() => void window.dispatchEvent(ev("pointerup", 10, 10)));
    act(() => void a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(click).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
