import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpenseBar } from "@/components/expense-bar";
import { SummaryTriple } from "@/components/summary-triple";
import { useReveal } from "@/components/use-reveal";

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
  vi.unstubAllGlobals();
});
const mount = (el: React.ReactElement) => {
  root = createRoot(host);
  act(() => root!.render(el));
};
const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("Stage 6R: 支出内訳バー", () => {
  const items = [
    { id: "pokemon_card", label: "カード", amount: 12000, color: "red" },
    { id: "goods", label: "サプライ", amount: 5000, color: "blue" },
    { id: "expense", label: "経費", amount: 1500, color: "green" },
    { id: "none", label: "ゼロ", amount: 0, color: "gray" },
  ];
  it("金額0円の分類はバーに描画しない。バーの高さは約12px", () => {
    mount(createElement(ExpenseBar, { items }));
    expect(q("bar-seg-pokemon_card")).not.toBeNull();
    expect(q("bar-seg-none")).toBeNull();
    expect(q("bar-seg-goods")!.querySelector("span")!.className).toContain("h-3");
  });
  it("色をタップすると金額と割合が出て、同じ色の再タップで閉じ、別の色で切り替わる", () => {
    mount(createElement(ExpenseBar, { items }));
    expect(q("bar-tip")).toBeNull();
    act(() => q("bar-seg-pokemon_card")!.click());
    expect(q("bar-tip")!.textContent).toBe("カード：12,000円（65%）");
    act(() => q("bar-seg-goods")!.click());
    expect(q("bar-tip")!.textContent).toBe("サプライ：5,000円（27%）");
    act(() => q("bar-seg-goods")!.click());
    expect(q("bar-tip")).toBeNull();
  });
  it("バー以外をタップすると閉じる", () => {
    mount(createElement(ExpenseBar, { items }));
    act(() => q("bar-seg-expense")!.click());
    expect(q("bar-tip")).not.toBeNull();
    act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(q("bar-tip")).toBeNull();
  });
  it("極端に小さい分類は『1%未満』で確認できる。支出が0円なら『支出なし』", () => {
    mount(createElement(ExpenseBar, { items: [{ id: "a", label: "カード", amount: 100000, color: "r" }, { id: "b", label: "経費", amount: 10, color: "g" }] }));
    act(() => q("bar-seg-b")!.click());
    expect(q("bar-tip")!.textContent).toContain("1%未満");
    act(() => root!.render(createElement(ExpenseBar, { items: [{ id: "a", label: "カード", amount: 0, color: "r" }] })));
    expect(q("expense-bar-empty")!.textContent).toContain("支出なし");
  });
});

describe("Stage 6R: 購入／買取／枚数の3分割", () => {
  it("3つのエリアに項目名と数値。テキストとしては「購入 12,000円」の形", () => {
    mount(createElement(SummaryTriple, { testId: "s", expanded: false, onToggle: () => undefined, cells: [{ label: "購入", value: "12,000円" }, { label: "買取", value: "10,000円", sub: "12/1", subTestId: "d" }, { label: "枚数", value: "3枚" }] }));
    expect([0, 1, 2].map((i) => q(`s-cell-${i}`)!.querySelector("span")!.textContent)).toEqual(["購入", "買取", "枚数"]);
    expect(q("s")!.textContent).toContain("購入 12,000円");
    expect(q("s")!.textContent).toContain("買取 10,000円");
    expect(q("s")!.textContent).toContain("3枚");
    expect(q("d")!.textContent).toBe("12/1");
    expect(q("s")!.className).toContain("grid-cols-3");
  });
  it("金額が大きいときは文字を小さくする", () => {
    mount(createElement(SummaryTriple, { testId: "s", expanded: false, onToggle: () => undefined, cells: [{ label: "購入", value: "1,234,567円" }, { label: "買取", value: "—" }, { label: "枚数", value: "3枚" }] }));
    const big = q("s-cell-0")!.querySelectorAll("span")[2];
    expect(big.className).toMatch(/text-(xs|\[11px\])/);
  });
});

describe("Stage 6R: 順次フェード表示", () => {
  type Cb = (entries: { target: Element; isIntersecting: boolean }[]) => void;
  let cb: Cb | null = null;
  const observed = new Set<Element>();
  class FakeIO {
    constructor(c: Cb) {
      cb = c;
    }
    observe(el: Element) {
      observed.add(el);
    }
    unobserve(el: Element) {
      observed.delete(el);
    }
    disconnect() {
      observed.clear();
    }
  }
  function List({ ids }: { ids: string[] }) {
    const reveal = useReveal(true);
    return createElement("ul", null, ids.map((id) => createElement("li", { key: id, ref: reveal.bind(id), className: "reveal", "data-testid": `t-${id}` }, id)));
  }
  const rectOf = (el: Element, left: number, top: number) => (el.getBoundingClientRect = () => ({ x: left, y: top, left, top, right: left + 50, bottom: top + 70, width: 50, height: 70, toJSON: () => ({}) }));
  beforeEach(() => {
    observed.clear();
    cb = null;
    vi.stubGlobal("IntersectionObserver", FakeIO);
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => (f(0), 1));
  });

  it("画面に入ったカードを、左上→右、行ごとの順に遅らせてフェードインさせる（画像の読み込みは待たない）", () => {
    mount(createElement(List, { ids: ["a", "b", "c", "d"] }));
    // 2列×2行。配置は a(左上) b(右上) c(左下) d(右下)
    rectOf(q("t-a")!, 0, 0);
    rectOf(q("t-b")!, 60, 0);
    rectOf(q("t-c")!, 0, 80);
    rectOf(q("t-d")!, 60, 80);
    expect(q("t-a")!.getAttribute("data-reveal")).toBeNull(); // 枠だけ（透明）
    // 交差の通知は順不同で届いてもよい
    act(() => cb!(["d", "b", "c", "a"].map((id) => ({ target: q(`t-${id}`)!, isIntersecting: true }))));
    const delay = (id: string) => parseInt(q(`t-${id}`)!.style.getPropertyValue("--d"), 10);
    expect(delay("a")).toBeLessThan(delay("b"));
    expect(delay("b")).toBeLessThan(delay("c"));
    expect(delay("c")).toBeLessThan(delay("d"));
    expect(delay("d")).toBeLessThanOrEqual(1200); // 画面内は約1〜1.5秒で完了
    expect(q("t-a")!.getAttribute("data-reveal")).toBe("in");
  });
  it("画面外のカードは、表示範囲に入るまで演出しない", () => {
    mount(createElement(List, { ids: ["a", "b"] }));
    act(() => cb!([{ target: q("t-a")!, isIntersecting: true }, { target: q("t-b")!, isIntersecting: false }]));
    expect(q("t-a")!.getAttribute("data-reveal")).toBe("in");
    expect(q("t-b")!.getAttribute("data-reveal")).toBeNull();
    act(() => cb!([{ target: q("t-b")!, isIntersecting: true }]));
    expect(q("t-b")!.getAttribute("data-reveal")).toBe("in");
  });
  it("一度表示したカードは、並び替え・作り直し（再マウント）でも再演出しない", () => {
    function Wrap({ ids }: { ids: string[] }) {
      return createElement(List, { ids });
    }
    mount(createElement(Wrap, { ids: ["a", "b"] }));
    act(() => cb!([{ target: q("t-a")!, isIntersecting: true }, { target: q("t-b")!, isIntersecting: true }]));
    act(() => root!.render(createElement(Wrap, { ids: ["b", "a"] })));
    expect(q("t-a")!.getAttribute("data-reveal")).toBe("in"); // 並び替えでは属性が変わらない（再生し直さない）
    expect(q("t-b")!.getAttribute("data-reveal")).toBe("in");
  });
  it("動きを減らす設定では、演出せず即表示する", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
    mount(createElement(List, { ids: ["a"] }));
    expect(q("t-a")!.getAttribute("data-reveal")).toBe("done");
  });
  it("IntersectionObserver が無い環境でも、カードが透明のまま残らない", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    mount(createElement(List, { ids: ["a"] }));
    expect(q("t-a")!.getAttribute("data-reveal")).toBe("done");
  });
});
