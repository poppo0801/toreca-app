import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgeLaunch, parseLifeMark } from "@/lib/lifecycle";
import { readClientErrorLog, startLifecycleTracking } from "@/lib/client-resilience";

describe("Stage 7D: 前回の終わり方の判定", () => {
  const T = 1_000_000;
  it("初回・正常に閉じた場合は何も記録しない", () => {
    expect(judgeLaunch(null, T).kind).toBe("first");
    expect(judgeLaunch({ state: "closed", at: T - 5000, path: "/lotteries", build: "a" }, T).kind).toBe("normal");
  });
  it("バックグラウンドのまま戻らなかった＝OSによる破棄（iOSでは通常の動作）。画面と経過時間を返す", () => {
    expect(judgeLaunch({ state: "hidden", at: T - 600_000, path: "/settings/masters", build: "a" }, T)).toEqual({ kind: "discarded_in_background", path: "/settings/masters", awayMs: 600_000 });
  });
  it("表示中のまま閉じる通知なしに終わった＝表示中にプロセスが終了した可能性", () => {
    expect(judgeLaunch({ state: "visible", at: T - 120_000, path: "/settings/masters", build: "a" }, T)).toEqual({ kind: "terminated_while_visible", path: "/settings/masters", sinceMs: 120_000 });
  });
  it("壊れた印は無視する", () => {
    expect(parseLifeMark("not json")).toBeNull();
    expect(parseLifeMark(JSON.stringify({ state: "weird", at: 1, path: "/" }))).toBeNull();
    expect(parseLifeMark(null)).toBeNull();
  });
});

describe("Stage 7D: 画面の終了の検出と記録（端末内）", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());
  it("表示中に終了した起動の次回に『表示中に終了した可能性』を記録し、正常に閉じた次回は記録しない", () => {
    const stop1 = startLifecycleTracking(() => "/settings/masters");
    // ページが閉じる通知なしに終了（プロセス終了）した想定: stop だけ呼び、pagehide は送らない
    stop1();
    const stop2 = startLifecycleTracking(() => "/lotteries");
    const log = readClientErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: "terminated", where: "lifecycle" });
    expect(log[0].message).toContain("/settings/masters");
    // 正常に閉じる（pagehide）→ 次の起動では記録しない
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    stop2();
    startLifecycleTracking(() => "/lotteries")();
    expect(readClientErrorLog()).toHaveLength(1);
  });
  it("バックグラウンドへ移ってから破棄された起動の次回は『破棄された』として記録する（terminated とは区別）", () => {
    const stop1 = startLifecycleTracking(() => "/collection");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    stop1();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    startLifecycleTracking(() => "/lotteries")();
    const log = readClientErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: "discarded", where: "lifecycle" });
  });
});
