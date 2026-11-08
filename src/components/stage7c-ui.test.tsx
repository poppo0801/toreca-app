import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { CollectionData } from "@/app/(app)/collection/actions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-11-08T03:00:00Z");
const appData = createMockData(NOW);
const refresh = vi.fn();
const reset = vi.fn();
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(""), useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }), usePathname: () => "/collection" }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data: appData, now: NOW, profile: appData.profiles[0], settings: {}, saveSettings: vi.fn(), persistent: true, reload: reloadApp }),
}));
const reloadApp = vi.fn(async () => null);
vi.mock("@/lib/data-source", () => ({ IS_SUPABASE_MODE: true }));

// コレクションの取得とアクションの差し替え
const loads: (() => Promise<{ ok: true; data: CollectionData } | { ok: false; error: string }>)[] = [];
vi.mock("@/app/(app)/collection/actions", () => ({
  loadCollectionAction: () => (loads.shift() ?? (() => Promise.resolve({ ok: false as const, error: "no more" })))(),
  reorderCardsAction: vi.fn(),
  setFavoriteAction: vi.fn(),
  reorderFavoritesAction: vi.fn(),
}));
vi.mock("@/app/(app)/collection/market-actions", () => ({
  updateMarketPricesAction: vi.fn(async () => ({ ok: true as const, result: { summary: { updated: 1, unlisted: 0, ambiguous: 0, insufficient: 0, noPrice: 0, total: 1 }, source: "upload", csvRows: 1, csvUpdatedAt: null, ambiguous: [] } })),
  setMarketLinkAction: vi.fn(),
}));

import { CollectionView, type CardPanelHandle } from "@/components/collection-view";
import { RecoverableError } from "@/components/recoverable-error";
import { SummaryTriple } from "@/components/summary-triple";
import { useLatestLoader } from "@/components/use-latest-loader";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  loads.length = 0;
  refresh.mockClear();
  reset.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

/** 状態Bのカード2枚（購入300円×2）。販売の基準相場1,000円。marketB は状態Bの実際の販売相場（取得した相場）。 */
const dataWith = (marketB: number | null): CollectionData => ({
  cards: [{ id: "c1", name: "テストカード", cardNumber: "1/9", setCode: "T", rarity: "RR", cardType: "", productName: "テストパック", imagePath: null, thumbPath: null, imageSha: null, sourceUrl: null, analysisRunId: null, createdAt: "2026-11-01T00:00:00Z" }],
  holdings: [{ id: "h1", cardId: "c1", quantity: 2, acquiredOn: "2026-11-01", unitPriceYen: 300, source: "", condition: "B", note: "", purchaseId: null, createdAt: "2026-11-01T00:00:00Z" }],
  prices: [
    { id: "p1", cardId: "c1", kind: "sale", amountYen: 1000, confirmedOn: "2026-11-01", source: "", sourceUrl: null, createdAt: "2026-11-01T00:00:00Z" },
    { id: "p2", cardId: "c1", kind: "buyback", amountYen: 500, confirmedOn: "2026-11-01", source: "", sourceUrl: null, createdAt: "2026-11-01T00:00:00Z" },
  ],
  market: marketB === null ? [] : [{ cardId: "c1", kind: "sale", conditionGrade: "B", medianYen: marketB, lowYen: marketB, highYen: marketB, sampleCount: 3, outlierCount: 0, shops: [], source: "x", sourceUrl: null, csvUpdatedAt: null, fetchedAt: "2026-11-08T00:00:00Z" }],
  favorites: [],
  thumbUrls: {},
  orders: [],
  multipliers: { A: 100, B: 85, C: 65 },
});

describe("Stage 7C: 相場更新後の集計（コレクション）", () => {
  const mountView = async () => {
    const ref = createRef<CardPanelHandle>();
    act(() => root.render(createElement(CollectionView, { ref })));
    await flush();
    act(() => (q("summary-line") as HTMLElement).click()); // 詳細（参考価値）を開いておく
    return ref;
  };
  const sale = () => q("collection-stats")!.textContent ?? "";
  const runMarket = async (ref: { current: CardPanelHandle | null }) => {
    act(() => ref.current!.openMarket());
    await flush();
    await act(async () => (q("market-run") as HTMLElement).click());
    await flush();
    await flush();
  };

  it("相場の更新が完了すると、画面全体をリロードせずに参考価値が更新される。購入・買取の実金額は変わらない", async () => {
    loads.push(async () => ({ ok: true, data: dataWith(null) }));
    const ref = await mountView();
    expect(q("summary-line-cell-0")!.textContent).toContain("600円"); // 購入=実購入金額（300円×2）
    expect(q("summary-line-cell-1")!.textContent).toContain("850円"); // 買取=500円×85%×2枚
    expect(sale()).toContain("1,700円"); // 販売=1,000円×85%×2枚（倍率）
    loads.push(async () => ({ ok: true, data: dataWith(700) }));
    await runMarket(ref);
    expect(sale()).toContain("1,400円"); // 状態Bの実際の販売相場 700円×2枚
    expect(q("summary-line-cell-0")!.textContent).toContain("600円"); // 購入金額は変わらない
    expect(q("summary-line-cell-1")!.textContent).toContain("850円"); // 買取は従来の計算のまま
    expect(q("summary-line")!.getAttribute("data-refreshing")).toBeNull();
  });
  it("更新後の再取得が失敗しても、不正な集計を出さない（今の表示を保ち、エラーを知らせる）", async () => {
    loads.push(async () => ({ ok: true, data: dataWith(700) }));
    const ref = await mountView();
    expect(sale()).toContain("1,400円");
    loads.push(async () => ({ ok: false, error: "取得に失敗しました" }), async () => ({ ok: false, error: "取得に失敗しました" }));
    await runMarket(ref);
    expect(sale()).toContain("1,400円"); // 古いが整合した値のまま
    expect(document.body.textContent).toContain("取得に失敗しました");
  });
  it("複数カードでも一度の更新で全体が再計算される", async () => {
    const two = (b: number | null): CollectionData => {
      const d = dataWith(b);
      return { ...d, cards: [...d.cards, { ...d.cards[0], id: "c2", name: "カード2" }], holdings: [...d.holdings, { ...d.holdings[0], id: "h2", cardId: "c2" }], prices: [...d.prices, { ...d.prices[0], id: "p3", cardId: "c2" }], market: b === null ? [] : [...d.market, { ...d.market[0], cardId: "c2" }] };
    };
    loads.push(async () => ({ ok: true, data: two(null) }));
    const ref = await mountView();
    expect(sale()).toContain("3,400円");
    loads.push(async () => ({ ok: true, data: two(700) }));
    await runMarket(ref);
    expect(sale()).toContain("2,800円");
  });
  it("詳細（展開）に収録パック別の集計と「一部のカードだけの集計です」の説明は出ない。レアリティ別は残る", async () => {
    loads.push(async () => ({ ok: true, data: dataWith(null) }));
    await mountView();
    const stats = q("collection-stats")!;
    expect(stats.textContent).not.toContain("収録パック別");
    expect(stats.textContent).not.toContain("一部のカードだけ");
    expect(stats.textContent).toContain("レアリティ別");
    // 余白の改善: 左右にも余白があり、行の間隔が広い
    expect(stats.className).toContain("px-3.5");
    expect(stats.querySelector("dl")!.className).toContain("gap-y-2.5");
  });
});

describe("Stage 7C: 最新の取得だけを反映するローダー", () => {
  function Probe({ fetchers }: { fetchers: (() => Promise<{ ok: true; data: string } | { ok: false; error: string }>)[] }) {
    return createElement(ProbeInner, { fetchers });
  }
  const state = { data: "", error: null as string | null };
  let api: { load: () => Promise<void>; refreshing: boolean } | null = null;
  function ProbeInner({ fetchers }: { fetchers: (() => Promise<{ ok: true; data: string } | { ok: false; error: string }>)[] }) {
    const fetcher = (() => (fetchers.shift() as NonNullable<(typeof fetchers)[number]>)()) as never;
    const r = useLatestLoader<string>(fetcher, (d) => void (state.data = d), (e) => void (state.error = e));
    api = r;
    return createElement("span", { "data-testid": "p", "data-r": String(r.refreshing) });
  }
  it("古い取得が遅れて届いても、新しい取得の結果を上書きしない", async () => {
    state.data = "";
    let slow!: (v: { ok: true; data: string }) => void;
    const fetchers = [() => new Promise<{ ok: true; data: string }>((r) => (slow = r)), async () => ({ ok: true as const, data: "new" })];
    const stable = fetchers; // 同じ配列を使い続ける
    act(() => root.render(createElement(Probe, { fetchers: stable })));
    let first!: Promise<void>;
    act(() => void (first = api!.load()));
    await act(async () => void (await api!.load()));
    expect(state.data).toBe("new");
    slow({ ok: true, data: "old" });
    await act(async () => void (await first));
    expect(state.data).toBe("new");
    expect(q("p")!.getAttribute("data-r")).toBe("false");
  });
});

describe("Stage 7C: 集計の取得中表示", () => {
  it("refreshing の間は薄く表示し aria-busy を付ける。通常は付けない", () => {
    const cells = [{ label: "購入", value: "1円" }, { label: "買取", value: "2円" }, { label: "枚数", value: "3枚" }] as never;
    act(() => root.render(createElement(SummaryTriple, { testId: "s", expanded: false, onToggle: () => undefined, cells, refreshing: true })));
    expect(q("s")!.getAttribute("aria-busy")).toBe("true");
    expect(q("s")!.className).toContain("opacity-60");
    act(() => root.render(createElement(SummaryTriple, { testId: "s", expanded: false, onToggle: () => undefined, cells })));
    expect(q("s")!.getAttribute("aria-busy")).toBeNull();
  });
});

describe("Stage 7C: エラー画面の自動復旧", () => {
  it("通信エラーは少し待って自動で再取得する（全画面の再読み込みはしない）。回数制限を超えたら操作ボタンを出す", async () => {
    vi.useFakeTimers();
    const reloadSpy = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload: reloadSpy, pathname: "/lotteries" }, configurable: true });
    act(() => root.render(createElement(RecoverableError, { error: new Error("Failed to fetch"), reset, scope: "app" })));
    expect(q("recoverable-error")!.getAttribute("data-state")).toBe("waiting");
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reloadSpy).not.toHaveBeenCalled();
    // 続けて起きても自動の再試行は60秒に2回まで → 3回目は操作ボタン
    act(() => root.render(createElement(RecoverableError, { error: new Error("Failed to fetch 2"), reset, scope: "app" })));
    await act(async () => void vi.advanceTimersByTime(1000));
    act(() => root.render(createElement(RecoverableError, { error: new Error("Failed to fetch 3"), reset, scope: "app" })));
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(q("recoverable-error")!.getAttribute("data-state")).toBe("gave_up");
    expect(q("error-retry")).not.toBeNull();
    expect(reloadSpy).not.toHaveBeenCalled();
    act(() => (q("error-retry") as HTMLElement).click());
    expect(reset).toHaveBeenCalled();
  });
  it("古い画面（JSの読み込み失敗）は最終手段として全画面を再読み込みする。ただしダイアログ表示中・直前に再読み込み済みなら行わない", async () => {
    vi.useFakeTimers();
    const reloadSpy = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload: reloadSpy, pathname: "/lotteries" }, configurable: true });
    // 入力中（ダイアログ表示中）は再読み込みしない
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    act(() => root.render(createElement(RecoverableError, { error: new Error("ChunkLoadError: Loading chunk 12 failed"), reset, scope: "app" })));
    await act(async () => void vi.advanceTimersByTime(100));
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(q("recoverable-error")!.getAttribute("data-state")).toBe("gave_up");
    dlg.remove();
    // 開いていなければ1回だけ再読み込みし、直後の同じエラーでは繰り返さない
    act(() => root.render(createElement(RecoverableError, { error: new Error("ChunkLoadError: Loading chunk 13 failed"), reset, scope: "app" })));
    await act(async () => void vi.advanceTimersByTime(100));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    act(() => root.render(createElement(RecoverableError, { error: new Error("ChunkLoadError: Loading chunk 14 failed"), reset, scope: "app" })));
    await act(async () => void vi.advanceTimersByTime(100));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
