import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { LotteryRepository } from "@/services/types";
import type { AppData } from "@/types/domain";

let pathname = "/lotteries";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...p }, children) }));
vi.mock("@/app/(app)/settings/notifications/actions", () => ({ rebindPushSubscription: vi.fn() }));

import { AppProvider, useApp } from "@/components/app-provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-26T03:00:00Z");
const data = (): AppData => createMockData(NOW);

/** 取得元を差し替えたリポジトリ（load だけ使う） */
function fakeRepo(load: () => Promise<AppData>): LotteryRepository {
  return { persistent: false, load } as unknown as LotteryRepository;
}

/** 画面側の確認用: 通知と再読み込みを公開する */
let ctx: ReturnType<typeof useApp> | null = null;
function Probe() {
  const c = useApp();
  useEffect(() => {
    ctx = c;
  });
  return createElement("div", { "data-testid": "app" }, "アプリ本体");
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  pathname = "/lotteries";
  ctx = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = (repo: LotteryRepository) => act(async () => root.render(createElement(AppProvider as React.ComponentType<{ repository: LotteryRepository }>, { repository: repo }, createElement(Probe))));
const splash = () => host.querySelector('[data-testid="splash"]');
const app = () => host.querySelector('[data-testid="app"]');
const flush = () => act(async () => {});

describe("起動時のロード画面", () => {
  it("データの準備ができるまでロード画面（ロゴ・名称・スピナー・読み込み中...）を出し、完了したら自動で通常画面に切り替える", async () => {
    let resolve!: (d: AppData) => void;
    await render(fakeRepo(() => new Promise<AppData>((r) => (resolve = r))));
    expect(splash()?.getAttribute("data-state")).toBe("loading");
    expect(splash()?.textContent).toContain("トレマネ");
    expect(splash()?.textContent).toContain("TCG manager");
    expect(splash()?.textContent).toContain("読み込み中...");
    expect(splash()?.querySelector(".animate-spin")).not.toBeNull();
    expect(app()).toBeNull();

    resolve(data());
    await flush();
    expect(splash()).toBeNull();
    expect(app()).not.toBeNull();
  });

  it("準備が速ければすぐ切り替わる（固定秒数は待たない）", async () => {
    vi.useFakeTimers();
    await render(fakeRepo(async () => data()));
    await flush();
    expect(app()).not.toBeNull(); // タイマーを進めていない
    expect(splash()).toBeNull();
  });

  it("読み込みに失敗したら、エラーと再試行・ログイン画面への導線を出す。再試行で成功すれば通常画面になる", async () => {
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error("データの取得に失敗しました: 500");
      return data();
    });
    await render(fakeRepo(load));
    await flush();
    expect(splash()?.getAttribute("data-state")).toBe("error");
    expect(splash()?.textContent).toContain("データの取得に失敗しました");
    expect(splash()?.querySelector('a[href="/login"]')).not.toBeNull();
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "再試行")!;
    expect(retry).toBeTruthy();

    fail = false;
    await act(async () => retry.click());
    await flush();
    expect(splash()).toBeNull();
    expect(app()).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("いつまでも終わらない読み込みは、一定時間でエラーにして無限ローディングを防ぐ", async () => {
    vi.useFakeTimers();
    await render(fakeRepo(() => new Promise<AppData>(() => {})));
    expect(splash()?.getAttribute("data-state")).toBe("loading");
    await act(async () => vi.advanceTimersByTimeAsync(26_000));
    expect(splash()?.getAttribute("data-state")).toBe("error");
    expect(splash()?.textContent).toContain("時間がかかっています");
  });
});

describe("起動後は全面ローディングを出さない", () => {
  it("ページ移動に伴う再取得の間も、通常画面のまま（ロード画面に戻らない）", async () => {
    let calls = 0;
    let resolveSecond!: (d: AppData) => void;
    const load = vi.fn(() => {
      calls++;
      return calls === 1 ? Promise.resolve(data()) : new Promise<AppData>((r) => (resolveSecond = r));
    });
    await render(fakeRepo(load));
    await flush();
    expect(app()).not.toBeNull();

    pathname = "/finance"; // ページ移動
    await render(fakeRepo(load));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(splash()).toBeNull(); // 再取得中でも画面は残る
    expect(app()).not.toBeNull();
    resolveSecond(data());
    await flush();
    expect(app()).not.toBeNull();
  });

  it("起動後の更新に失敗しても、画面全体をエラーにせず通知にとどめる", async () => {
    let fail = false;
    const load = vi.fn(async () => {
      if (fail) throw new Error("通信エラー");
      return data();
    });
    await render(fakeRepo(load));
    await flush();
    fail = true;
    await act(async () => {
      await ctx!.reload();
    });
    expect(splash()).toBeNull();
    expect(app()).not.toBeNull();
    expect(ctx!.notice).toContain("最新のデータを取得できませんでした");
  });
});
