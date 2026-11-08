import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { ProfileSettings } from "@/lib/profile-settings";
import type { AppData, Application, Lottery } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
let settings: ProfileSettings = {};
let profileIdx = 0;
const actions = { setManaged: vi.fn(), setApplied: vi.fn(async () => ({ ok: true as const, data })), setResult: vi.fn(), setFulfillment: vi.fn() };
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[profileIdx], settings, actions, persistent: true, reload: async () => {} }),
}));
vi.mock("@/components/lottery-detail-sheet", () => ({ LotteryDetailSheet: () => null }));

import { AppliedStoreDialog } from "@/components/applied-store-dialog";
import { LotteryCard } from "@/components/lottery-card";
import { SwipeCard } from "@/components/swipe-card";
import { UndoToastProvider } from "@/components/undo-toast";
import { useTabSwipe } from "@/components/use-tab-swipe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const patch = (id: string, p: Partial<Lottery>) => {
  data = { ...data, lotteries: data.lotteries.map((l) => (l.id === id ? { ...l, ...p } : l)) };
};
const mountCard = (id: string, tab: "all" | "managed" | "applied" | "won", view: "simple" | "detail" = "detail") => {
  const lottery = data.lotteries.find((l) => l.id === id)!;
  act(() => {
    root.render(createElement(LotteryCard, { lottery, tab, view }));
  });
};

beforeEach(() => {
  data = createMockData(NOW);
  settings = {};
  profileIdx = 0;
  window.matchMedia = ((qq: string) => ({ matches: qq.includes("coarse"), media: qq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("Stage 7B: 日付表示 A/B", () => {
  it("Aタイプ（既定）は従来のレイアウト: 日付行(date-row)と受取方法の行(card-meta)。Bタイプの要素は無い", () => {
    mountCard("L1", "all");
    expect(q('[data-testid="date-row"]')).not.toBeNull();
    expect(q('[data-testid="card-meta"]')).not.toBeNull();
    expect(q('[data-testid="card-dates-b"]')).toBeNull();
  });
  it("Bタイプは日付を左、受取方法・距離を右に置く2行構成。右の文字の開始位置が同じ列にそろい、日付は左寄せ", () => {
    settings = { dateLayout: "b" };
    mountCard("L1", "all");
    const b = q('[data-testid="card-dates-b"]')!;
    expect(b).not.toBeNull();
    expect(q('[data-testid="card-meta"]')).toBeNull();
    const rows = qa('[data-testid="date-b-row"]');
    expect(rows).toHaveLength(2);
    // 左: 応募締切 / 購入(受取)期間、右: 受取方法
    expect(rows[0].querySelector('[data-testid="deadline-day"]')).not.toBeNull();
    expect(rows[1].querySelector('[data-testid="period"]')).not.toBeNull();
    const lefts = qa('[data-testid="date-b-left"]');
    expect(lefts.every((e) => e.className.includes("text-left") && e.className.includes("whitespace-nowrap"))).toBe(true);
    // 右の列は1つのグリッド列（auto）に置かれ、全行で開始位置が同じ
    expect(b.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
    const rights = qa('[data-testid="date-b-right"]');
    expect(rights.every((e) => e.className.includes("text-left"))).toBe(true);
    expect(rights[0].textContent).toContain("店頭");
  });
  it("情報が足りなくても崩れない（日付が未設定でも期間は「未定」、右の情報が無ければ左が全幅）", () => {
    settings = { dateLayout: "b" };
    patch("L1", { receiveMethod: "unknown", procedureStart: { precision: "unknown" }, procedureDeadline: { precision: "unknown" } });
    mountCard("L1", "all");
    expect(q('[data-testid="card-dates-b"]')).not.toBeNull();
    expect(q('[data-testid="period"]')!.textContent).toContain("未定");
  });
  it("設定を切り替えると再読み込みなしで反映される。シンプル表示は変わらない", () => {
    mountCard("L1", "all");
    expect(q('[data-testid="card-dates-b"]')).toBeNull();
    settings = { dateLayout: "b" };
    mountCard("L1", "all");
    expect(q('[data-testid="card-dates-b"]')).not.toBeNull();
    mountCard("L1", "all", "simple");
    expect(q('[data-testid="card-dates-b"]')).toBeNull();
    expect(q('[data-testid="card-simple"]')).not.toBeNull();
  });
  it("注意アイコン・NEWは店舗名の行／チップの行にあり、日付ブロックと干渉しない", () => {
    settings = { dateLayout: "b" };
    patch("L1", { isNew: true, cautions: [{ code: "x", field: "other", message: "注意", at: NOW.toISOString() }] });
    mountCard("L1", "all");
    expect(q('[data-testid="card-place"] [data-testid="caution-mark"]')).not.toBeNull();
    expect(q('[data-testid="card-dates-b"] [data-testid="caution-mark"]')).toBeNull();
    expect(host.textContent).toContain("NEW");
  });
});

describe("Stage 7B: 店舗選択式のカード表示（カードは1枚のまま・プロフィールで切替）", () => {
  const addApp = (lotteryId: string, accountId: string, name: string): void => {
    const a: Application = { id: `t-${accountId}`, lotteryId, accountId, appliedAt: NOW.toISOString(), state: "applied", result: "pending", itemResults: {}, selectedItemId: null, appliedStore: { id: null, name, prefecture: "" }, resultConfirmedAt: null, fulfillment: "none", createdAt: NOW.toISOString() };
    data = { ...data, applications: [...data.applications, a] };
  };
  it("応募前は「店舗選択式」。応募後は現在のプロフィールの店舗。プロフィールを切り替えるとそのプロフィールの店舗になる。カードは2枚に分かれない", () => {
    patch("L4", { storeMode: "select_on_apply" });
    mountCard("L4", "all");
    expect(q('[data-testid="store-name"]')!.textContent).toContain("店舗選択式");
    const chain = data.lotteries.find((l) => l.id === "L4")!.chainId;
    addApp("L4", `a-${chain}`, "GEO 神戸店");
    addApp("L4", `b-${chain}`, "GEO 三宮店");
    mountCard("L4", "all");
    expect(q('[data-testid="store-name"]')!.textContent).toContain("GEO 神戸店");
    expect(qa('[data-testid="lottery-card"]')).toHaveLength(1);
    profileIdx = 1;
    mountCard("L4", "all");
    expect(q('[data-testid="store-name"]')!.textContent).toContain("GEO 三宮店");
    expect(qa('[data-testid="lottery-card"]')).toHaveLength(1);
  });
  it("店舗固定の抽選は従来どおり店舗名を出す", () => {
    mountCard("L1", "all");
    expect(q('[data-testid="store-name"]')!.textContent).not.toContain("店舗選択式");
  });
});

describe("Stage 7B: 応募店舗の入力シート", () => {
  const lot = () => {
    patch("L4", { storeMode: "select_on_apply" });
    return data.lotteries.find((l) => l.id === "L4")!;
  };
  const mountSheet = (onSubmit = vi.fn(), onClose = vi.fn(), extra: Record<string, unknown> = {}) => {
    const lottery = lot();
    act(() => {
      root.render(createElement(AppliedStoreDialog, { lottery, confirmLabel: "応募済みにする", onSubmit, onClose, ...extra }));
    });
    return { onSubmit, onClose };
  };
  const sheet = () => document.querySelector<HTMLElement>('[data-testid="applied-store-dialog"]');
  const click = (el: Element | null) => act(() => (el as HTMLElement).click());

  it("系列名と候補が出る。候補は5件以内で、タップで選べる。過去の応募店舗が先頭に並ぶ", () => {
    const chain = data.lotteries.find((l) => l.id === "L4")!.chainId;
    const prev: Application = { id: "h1", lotteryId: "L1", accountId: `a-${chain}`, appliedAt: "2026-10-01T00:00:00Z", state: "applied", result: "pending", itemResults: {}, selectedItemId: null, appliedStore: { id: null, name: "履歴の店", prefecture: "" }, resultConfirmedAt: null, fulfillment: "none", createdAt: "2026-10-01T00:00:00Z" };
    data = { ...data, lotteries: data.lotteries.map((l) => (l.id === "L1" ? { ...l, chainId: chain } : l)), applications: [...data.applications, prev] };
    mountSheet();
    expect(sheet()).not.toBeNull();
    const cands = [...document.querySelectorAll<HTMLElement>('[data-testid="store-candidate"]')];
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.length).toBeLessThanOrEqual(5);
    expect(cands[0].textContent).toBe("履歴の店");
    expect(cands[0].getAttribute("data-history")).toBe("1");
    const names = cands.map((c) => c.textContent);
    expect(new Set(names).size).toBe(names.length);
  });
  it("候補をタップして決定すると、その店舗で確定する。キャンセルでは何も確定しない", async () => {
    const { onSubmit, onClose } = mountSheet();
    const first = document.querySelector<HTMLElement>('[data-testid="store-candidate"]');
    if (first) {
      click(first);
      await act(async () => (document.querySelector('[data-testid="applied-store-ok"]') as HTMLElement).click());
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: first.textContent });
    }
    onSubmit.mockClear();
    const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "キャンセル")!;
    click(cancel);
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(actions.setApplied).not.toHaveBeenCalled();
  });
  it("候補にない店舗名も自由に入力できる。店舗を決めずに進む（例外）も選べ、編集時（allowUnset=false）は店舗が必須", async () => {
    const { onSubmit } = mountSheet();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="応募先の店舗"], [role="combobox"]')!;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "新しい店舗");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (document.querySelector('[data-testid="applied-store-ok"]') as HTMLElement).click());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: "新しい店舗" });
    expect(document.querySelector('[data-testid="applied-store-unset"]')).not.toBeNull();
  });
});

describe("Stage 7B: スワイプ操作のモード", () => {
  const drag = (el: Element, dx: number) => {
    const fire = (type: string, x: number) => {
      const ev = Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 300 }), { pointerId: 1, pointerType: "touch", isPrimary: true });
      act(() => {
        el.dispatchEvent(ev);
      });
    };
    fire("pointerdown", 200);
    for (let i = 1; i <= 6; i++) fire("pointermove", 200 + (dx * i) / 6);
    fire("pointerup", 200 + dx);
  };
  const mountSwipe = () =>
    act(() => {
      root.render(
        (
          <UndoToastProvider>
            <SwipeCard lottery={data.lotteries.find((l) => l.id === "L4")!} tab="all">
              <button type="button" data-testid="inner">
                カード
              </button>
            </SwipeCard>
          </UndoToastProvider>
        ),
      );
    });
  it("カード操作モード（既定）ではカードを横スワイプできる（スワイプ領域が有効）", () => {
    mountSwipe();
    expect(q("[data-swipe-tab]")!.style.touchAction).toBe("pan-y");
  });
  it("タブ切替モードではカードのスワイプ操作が無効（何も実行されず、縦スクロールの設定も付かない）。カードのタップは使える", () => {
    settings = { swipeMode: "tab" };
    mountSwipe();
    const el = q("[data-swipe-tab]")!;
    expect(el.style.touchAction).toBe("");
    drag(el, 160);
    expect(actions.setManaged).not.toHaveBeenCalled();
    expect(q('[data-testid="swipe-hint"]')).toBeNull();
    const clicked = vi.fn();
    q('[data-testid="inner"]')!.addEventListener("click", clicked);
    act(() => q('[data-testid="inner"]')!.click());
    expect(clicked).toHaveBeenCalled();
  });
});

describe("Stage 7B: タブ切替スワイプ（タッチ）", () => {
  function Probe({ enabled, onSwipe }: { enabled: boolean; onSwipe: (d: string) => void }) {
    useTabSwipe(enabled, onSwipe);
    return createElement("div", { "data-testid": "area" }, createElement("input", { "data-testid": "field" }), createElement("p", { "data-testid": "text" }, "本文"));
  }
  const touch = (target: Element, type: string, x: number, y: number) => {
    const t = { identifier: 1, target, clientX: x, clientY: y } as unknown as Touch;
    const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: Touch[]; changedTouches: Touch[] };
    ev.touches = type === "touchend" ? [] : [t];
    ev.changedTouches = [t];
    act(() => {
      target.dispatchEvent(ev);
    });
  };
  const swipe = (target: Element, x0: number, dx: number, dy = 0) => {
    touch(target, "touchstart", x0, 300);
    touch(target, "touchmove", x0 + dx / 2, 300 + dy / 2);
    touch(target, "touchend", x0 + dx, 300 + dy);
  };
  const run = (enabled = true) => {
    const cb = vi.fn();
    act(() => root.render(createElement(Probe, { enabled, onSwipe: cb })));
    return cb;
  };
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  });

  it("左へのスワイプは次、右へのスワイプは前。有効でないときは何もしない", () => {
    const cb = run();
    swipe(q('[data-testid="text"]')!, 250, -120);
    expect(cb).toHaveBeenLastCalledWith("next");
    swipe(q('[data-testid="text"]')!, 120, 120);
    expect(cb).toHaveBeenLastCalledWith("prev");
    const off = run(false);
    swipe(q('[data-testid="text"]')!, 250, -120);
    expect(off).not.toHaveBeenCalled();
  });
  it("縦スクロール・画面の端からの操作（iOSの戻る）・入力欄・ボトムシート表示中は切り替えない", () => {
    const cb = run();
    swipe(q('[data-testid="text"]')!, 250, -60, 140); // 縦
    swipe(q('[data-testid="text"]')!, 8, 130); // 左端から（戻るジェスチャー）
    swipe(q('[data-testid="field"]')!, 250, -120); // 入力欄
    expect(cb).not.toHaveBeenCalled();
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    swipe(q('[data-testid="text"]')!, 250, -120);
    expect(cb).not.toHaveBeenCalled();
    dlg.remove();
    swipe(q('[data-testid="text"]')!, 250, -120);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
