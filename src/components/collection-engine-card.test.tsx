import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved: string[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/app/(app)/settings/collection/engine-actions", () => ({
  setCollectionEngineAction: async (e: string) => {
    saved.push(e);
    return { ok: true, message: "保存しました。次回の収集実行から反映されます" };
  },
  runAutonomousNowAction: async () => ({ ok: true }),
}));
import { CollectionEngineCard, type EngineCardProps } from "@/components/collection-engine-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  saved.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (p: Partial<EngineCardProps> = {}) => act(() => root.render(createElement(CollectionEngineCard, { stored: "legacy", note: null, autonomousAvailable: true, runs: [], ...p })));

describe("情報収集方式の設定カード", () => {
  it("2つの方式を選べる。現在の方式と、最低限の運用状況（最終実行・新規発見・重複除外・費用）を表示する", () => {
    render({ stored: "autonomous", runs: [{ id: "1", trigger: "cron", status: "completed", started_at: "2026-11-20T00:00:00Z", stop_reason: "sufficient", error: null, counts: { found: 3, registered: 2, duplicates: 1, excluded: 4 }, cost_jpy: 4.5 }] });
    act(() => q("engine-toggle")!.click());
    expect((q("engine-autonomous") as HTMLInputElement).checked).toBe(true);
    const st = q("engine-status")!.textContent!;
    expect(st).toContain("自律型AI主体");
    expect(st).toContain("3件（登録2件）");
    expect(st).toContain("1件・4件");
    expect(st).toContain("4.5円");
  });
  it("開発環境以外では自律型を選べない。変更は次回の実行から反映される旨を示し、保存はサーバー操作を呼ぶ", async () => {
    render({ autonomousAvailable: false });
    act(() => q("engine-toggle")!.click());
    expect((q("engine-autonomous") as HTMLInputElement).disabled).toBe(true);
    expect(host.textContent).toContain("次回の収集実行から反映");
    render({ autonomousAvailable: true });
    act(() => (q("engine-autonomous") as HTMLInputElement).click());
    await act(async () => q("engine-save")!.click());
    expect(saved).toEqual(["autonomous"]);
    expect(q("engine-message")!.textContent).toContain("保存しました");
  });
  it("設定を読めない・方式が無効のときは、従来方式で動作中であることを理由つきで示す。開始できなかった実行の理由も表示する", () => {
    render({ stored: null, note: "収集方式の設定を読み込めなかったため、今回は従来方式で実行します（設定は変更していません）", runs: [{ id: "2", trigger: "cron", status: "skipped", started_at: "2026-11-20T00:00:00Z", stop_reason: null, error: "実AIの累計上限が未設定です", counts: {}, cost_jpy: 0 }] });
    act(() => q("engine-toggle")!.click());
    expect(q("engine-note")!.textContent).toContain("従来方式");
    expect(q("engine-status")!.textContent).toContain("実AIの累計上限が未設定です");
    expect(q("engine-status")!.textContent).toContain("開始できず");
  });
});
