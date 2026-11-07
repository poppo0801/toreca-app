import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_COLLAPSE_MS, EXIT_SLIDE_MS, useApplyExitController, type ApplyExitApi, type ExitPhase } from "@/components/apply-exit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const out = {} as { api: ApplyExitApi; phases: Record<string, ExitPhase> };
let shown = false;

function Probe() {
  const c = useApplyExitController({ enabled: true, resetKey: "k", isShown: () => shown });
  useEffect(() => {
    out.api = c.api;
    out.phases = c.phases;
  });
  return null;
}
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  shown = false;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Probe)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("退出アニメーション（共通）", () => {
  it("スワイプ: 保存の完了を待たずに、待機のあと下のカードを詰め始める。一覧から外すのは保存の成功のあと", async () => {
    act(() => void out.api.begin("a", { dir: "left", waitMs: 160, slid: true }));
    expect(out.phases.a).toBe("hold");
    await tick(159);
    expect(out.phases.a).toBe("hold");
    await tick(2);
    expect(out.phases.a).toBe("collapsing"); // 保存の応答がまだでも詰め始める
    await tick(EXIT_COLLAPSE_MS + 50);
    expect(out.phases.a).toBe("collapsing"); // 保存の成功を待って、まだ一覧に残す（消えて再表示されるちらつきを防ぐ）
  });
  it("スワイプ: 保存が成功したら、詰め終わった時点で一覧から外す。先に成功していても詰め終わるまで外さない", async () => {
    const h = out.api.begin("a", { waitMs: 160, slid: true });
    act(() => h.ok());
    await tick(200);
    expect(out.phases.a).toBe("collapsing");
    await tick(EXIT_COLLAPSE_MS + 20);
    expect(out.phases.a).toBeUndefined();
  });
  it("スワイプ: 保存に失敗したら詰めている途中でも元に戻す", async () => {
    const h = out.api.begin("a", { waitMs: 160, slid: true });
    await tick(200);
    expect(out.phases.a).toBe("collapsing");
    act(() => h.fail());
    expect(out.phases.a).toBeUndefined();
  });
  it("★・応募: 保存の成功と待機がそろってから、スライド→詰める→外す（従来どおり）", async () => {
    const h = out.api.begin("a", { waitMs: 320 });
    await tick(400);
    expect(out.phases.a).toBe("hold"); // 保存の成功がまだ
    act(() => h.ok());
    await tick(100);
    expect(out.phases.a).toBe("sliding");
    await tick(EXIT_SLIDE_MS);
    expect(out.phases.a).toBe("collapsing");
    await tick(EXIT_COLLAPSE_MS + 20);
    expect(out.phases.a).toBeUndefined();
  });
  it("保存後もそのタブに残るカードは退出しない", async () => {
    shown = true;
    const h = out.api.begin("a", { waitMs: 0 });
    act(() => h.ok());
    await tick(200);
    expect(out.phases.a).toBeUndefined();
  });
});
