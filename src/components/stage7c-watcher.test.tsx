import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reload = vi.fn(async (_o?: { silent?: boolean }) => ({}) as never);
let path = "/lotteries";
vi.mock("next/navigation", () => ({ usePathname: () => path, useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ reload }) }));
vi.mock("@/lib/data-source", () => ({ IS_SUPABASE_MODE: true }));
vi.mock("@/lib/client-resilience", async (orig) => {
  const m = await orig<typeof import("@/lib/client-resilience")>();
  return { ...m, BUILD_ID: "aaaaaaa" };
});

import { ResilienceWatcher } from "@/components/resilience-watcher";
import { readClientErrorLog } from "@/lib/client-resilience";

let root: Root;
let host: HTMLDivElement;
const locDesc = Object.getOwnPropertyDescriptor(window, "location");
const NOW0 = Date.parse("2026-11-08T03:00:00Z");
let now = NOW0;
const setVisibility = (v: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
  act(() => void document.dispatchEvent(new Event("visibilitychange")));
};
// 復帰直後は処理を集中させないため、取得は少し待ってから行う（resilience-watcher の待ち時間より長く待つ）
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 700))));
const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  now = NOW0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  reload.mockClear();
  window.localStorage.clear();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ build: "aaaaaaa" }) })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(ResilienceWatcher)));
});
afterEach(() => {
  if (locDesc) Object.defineProperty(window, "location", locDesc);
  path = "/lotteries";
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Stage 7C: バックグラウンド復帰", () => {
  it("数十秒の切り替えでは何も再取得しない（画面・状態を保つ）", async () => {
    now += 60_000; // 起動から1分後に離れる
    setVisibility("hidden");
    now += 10_000;
    setVisibility("visible");
    await flush();
    expect(reload).not.toHaveBeenCalled();
  });
  it("数分・数時間後の復帰では、データだけを静かに（silent）再取得する。画面全体のリロードはしない", async () => {
    const loc = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload: loc }, configurable: true });
    now += 60_000;
    setVisibility("hidden");
    now += 3 * 3600_000;
    setVisibility("visible");
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith({ silent: true });
    expect(loc).not.toHaveBeenCalled();
    // 続けてすぐ戻っても重ねて取得しない
    now += 1000;
    setVisibility("hidden");
    now += 25_000;
    setVisibility("visible");
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("オフラインで復帰したら取得を待ち、接続が戻った（online）ときに1回だけ取得する", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    now += 60_000;
    setVisibility("hidden");
    now += 5 * 60_000;
    setVisibility("visible");
    await flush();
    expect(reload).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    now += 30_000;
    await act(async () => void window.dispatchEvent(new Event("online")));
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("Stage 7C: 新バージョンの検出とエラーの記録", () => {
  it("復帰時に新しいビルドを検出したら、小さな通知だけを出す（利用中の画面は突然リロードしない）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ build: "bbbbbbb" }) })));
    const loc = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload: loc }, configurable: true });
    now += 60_000;
    setVisibility("hidden");
    now += 10 * 60_000;
    setVisibility("visible");
    await flush();
    await flush();
    expect(q("update-banner")).not.toBeNull();
    expect(loc).not.toHaveBeenCalled();
  });
  it("同じビルドなら通知しない", async () => {
    now += 60_000;
    setVisibility("hidden");
    now += 10 * 60_000;
    setVisibility("visible");
    await flush();
    await flush();
    expect(q("update-banner")).toBeNull();
  });
  it("古いJavaScriptの読み込み失敗を検出して通知し、種別・画面・復帰直後かを端末内に記録する（トークンは残さない）", async () => {
    act(() => void window.dispatchEvent(new ErrorEvent("error", { error: new Error("Loading chunk 9 failed. token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk") })));
    expect(q("update-banner")).not.toBeNull();
    const log = readClientErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: "chunk", where: "error", build: expect.any(String), online: true });
    expect(JSON.stringify(log)).not.toContain("eyJ");
    // 同じエラーを短時間に繰り返しても1件だけ
    act(() => void window.dispatchEvent(new ErrorEvent("error", { error: new Error("Loading chunk 9 failed. token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk") })));
    expect(readClientErrorLog()).toHaveLength(1);
  });
  it("新バージョンを検出している間に画面を移動したら、入力中でなければ1回だけ自然に切り替える。入力中（ダイアログ表示中）は切り替えない", async () => {
    const loc = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload: loc }, configurable: true });
    act(() => void window.dispatchEvent(new ErrorEvent("error", { error: new Error("ChunkLoadError: Loading chunk 1 failed") })));
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    path = "/finance";
    act(() => root.render(createElement(ResilienceWatcher)));
    expect(loc).not.toHaveBeenCalled();
    dlg.remove();
    path = "/collection";
    act(() => root.render(createElement(ResilienceWatcher)));
    expect(loc).toHaveBeenCalledTimes(1);
    path = "/battles";
    act(() => root.render(createElement(ResilienceWatcher)));
    expect(loc).toHaveBeenCalledTimes(1); // 10分以内は繰り返さない
  });
});
