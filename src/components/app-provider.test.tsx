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
const saveCalls: { patch: Record<string, unknown>; resolve: (v: { ok: true }) => void }[] = [];
vi.mock("@/app/(app)/settings/profile-settings-actions", () => ({
  saveProfileSettings: (_id: string, patch: Record<string, unknown>) => new Promise((resolve) => saveCalls.push({ patch, resolve: resolve as (v: { ok: true }) => void })),
  copyProfileSettings: vi.fn(),
}));

import { AppProvider, resolveActorId, useApp } from "@/components/app-provider";

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

describe("通信の一時的な失敗からの復旧（Stage 7C）", () => {
  it("起動時の通信エラー（iPhoneの Load failed など）は自動でやり直し、エラー画面にせず通常画面になる", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const load = vi.fn(() => {
      calls++;
      return calls < 3 ? Promise.reject(new TypeError("Load failed")) : Promise.resolve(data());
    });
    await render(fakeRepo(load));
    expect(splash()?.getAttribute("data-state")).toBe("loading");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(load).toHaveBeenCalledTimes(3);
    expect(splash()).toBeNull();
    expect(app()).not.toBeNull();
  });
  it("通信エラーが続くときは3回でやめて、再試行・ログイン画面への導線のあるエラーにする（ログアウトはしない）", async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    await render(fakeRepo(load));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(load).toHaveBeenCalledTimes(3);
    expect(splash()?.getAttribute("data-state")).toBe("error");
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

    pathname = "/collection"; // ページ移動（画面の外でデータが変わりうる画面。コア画面どうしの直近の移動は取り直さない）
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

describe("設定の連続操作（表示切替を続けて押したとき）", () => {
  it("保存中に続けて押しても、押した順に積み重なり、前の保存の完了で画面が巻き戻らない。保存は1件ずつ順に行う", async () => {
    saveCalls.length = 0;
    const server: Record<string, Record<string, unknown>> = {};
    const base = data();
    const repo = { persistent: true, load: async () => ({ ...base, profileSettings: JSON.parse(JSON.stringify(server)) }) } as unknown as LotteryRepository;
    await render(repo);
    await flush();
    const view = () => ctx!.settings.cardView ?? "detail";
    expect(view()).toBe("detail");

    await act(async () => void ctx!.saveSettings({ cardView: "simple" })); // 1回目の押下（保存はまだ終わらない）
    expect(view()).toBe("simple"); // すぐ画面に反映
    await act(async () => void ctx!.saveSettings({ cardView: "detail" })); // 2回目の押下
    expect(view()).toBe("detail");
    expect(saveCalls).toHaveLength(1); // 2件目は1件目の完了を待つ（順序が入れ替わらない）

    // 1回目の保存が完了 → サーバーの値は "simple"。しかし2回目が保存中なので、画面は "detail" のまま（巻き戻らない）
    server[ctx!.profile.id] = { cardView: "simple" };
    await act(async () => saveCalls[0].resolve({ ok: true }));
    await flush();
    expect(view()).toBe("detail");
    expect(saveCalls).toHaveLength(2);

    // 2回目が完了 → サーバーも "detail" になり、最終的に一致する
    server[ctx!.profile.id] = { cardView: "detail" };
    await act(async () => saveCalls[1].resolve({ ok: true }));
    await flush();
    expect(view()).toBe("detail");
  });
});

describe("操作者の解決（Stage 7E: 第二ユーザーの応募済みエラーの根本原因）", () => {
  const profiles = [{ id: "pA" }, { id: "pB" }, { id: "pC", active: false }];
  it("画面に表示しているプロフィールと同じ規則で操作者を決める: 選択中 → 端末に保存した選択 → 先頭", () => {
    expect(resolveActorId(profiles, "pB", null)).toBe("pB");
    // 再読み込み後は state が未設定。端末に保存した第二ユーザーが操作者になる（以前は先頭の pA になっていた）
    expect(resolveActorId(profiles, null, "pB")).toBe("pB");
    expect(resolveActorId(profiles, null, null)).toBe("pA");
    expect(resolveActorId(profiles, null, "unknown")).toBe("pA");
    expect(resolveActorId(profiles, "pC", null)).toBe("pA"); // 無効なプロフィールは使わない
    expect(resolveActorId([], null, "pB")).toBeUndefined();
  });
  it("端末に第二ユーザーが保存されているとき、操作（run）の操作者は表示中の第二ユーザーになる", async () => {
    window.localStorage.setItem("tcg.device.profileId", "pB");
    const seen: string[] = [];
    const repo = { persistent: false, load: async () => data(), setApplied: async (actor: string) => (seen.push(actor), { ok: true as const, data: data() }) } as unknown as LotteryRepository;
    await render(repo);
    await flush();
    expect(ctx?.profile.id).toBe("pB");
    await act(async () => void (await ctx!.actions.setApplied("L1", "b-c1", true)));
    expect(seen).toEqual(["pB"]);
    window.localStorage.removeItem("tcg.device.profileId");
  });
});

describe("Stage 7O: ページ移動の再取得・楽観的更新", () => {
  it("コア画面どうしの直近15秒以内の移動は取り直さない。マスター・コレクションなど画面の外で変わりうる画面からは取り直す", async () => {
    const load = vi.fn(() => Promise.resolve(data()));
    await render(fakeRepo(load));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    pathname = "/purchases";
    await render(fakeRepo(load));
    await flush();
    expect(load).toHaveBeenCalledTimes(1); // 直近の取得があるので取り直さない
    pathname = "/collection";
    await render(fakeRepo(load));
    await flush();
    expect(load).toHaveBeenCalledTimes(2); // コレクションへは取り直す
    pathname = "/finance";
    await render(fakeRepo(load));
    await flush();
    expect(load).toHaveBeenCalledTimes(3); // コレクションから戻るときも取り直す
  });

  it("再取得した内容が同じなら、画面の状態（data の参照）は変わらず再描画されない", async () => {
    const load = vi.fn(() => Promise.resolve(data()));
    await render(fakeRepo(load));
    await flush();
    const before = ctx!.data;
    await act(async () => {
      await ctx!.reload();
    });
    expect(ctx!.data).toBe(before);
  });

  it("★の楽観的更新: 押した直後に画面へ反映し、失敗したら元の表示へ戻してエラーを通知する。応募状態は楽観的に切り替えない（サーバーで保存できてから）", async () => {
    const d = data();
    const lot = d.lotteries.find((l) => !(d.management.find((m) => m.lotteryId === l.id)?.isManaged))!;
    const acc = d.accounts.find((x) => x.chainId === lot.chainId && x.profileId === d.profiles[0].id)!;
    let finish!: (o: { ok: false; error: string }) => void;
    const repo = { persistent: true, load: () => Promise.resolve(d), setManaged: () => new Promise((r) => (finish = r)), setApplied: () => new Promise(() => {}) } as unknown as LotteryRepository;
    await render(repo);
    await flush();
    const managed = () => ctx!.data.management.find((m) => m.lotteryId === lot.id)?.isManaged === true;
    expect(managed()).toBe(false);
    let p!: Promise<unknown>;
    await act(async () => {
      p = ctx!.actions.setManaged(lot.id, true);
    });
    expect(managed()).toBe(true); // サーバーの応答前に反映（押した直後）
    await act(async () => {
      finish({ ok: false, error: "保存できませんでした" });
      await p;
    });
    expect(managed()).toBe(false); // 失敗で元に戻る
    expect(ctx!.notice).toBe("保存できませんでした");
    // 応募状態: サーバーの応答まで画面は変わらない
    const applied = () => ctx!.data.applications.some((x) => x.lotteryId === lot.id && x.accountId === acc.id && x.state === "applied");
    await act(async () => {
      void ctx!.actions.setApplied(lot.id, acc.id, true);
    });
    expect(applied()).toBe(false);
  });
});
