import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeRun, type RunSummary } from "@/lib/collector/run-summary";

const summaries: RunSummary[] = [];
let notice: RunSummary | null = null;
let ackIds: string[] = [];
let manual: unknown[] = [];
const ack = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
vi.mock("@/app/(app)/collection-notice-actions", () => ({
  getRunNoticesAction: async () => ({ summaries, notice, ackIds, manual }),
  ackRunNoticesAction: (...a: unknown[]) => ack(...a),
}));

import { CollectionResultNotice } from "@/components/collection-result-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const sum = (cands: { status?: string; job_state: string }[], over: Partial<{ id: string; status: "running" | "done" }> = {}): RunSummary =>
  summarizeRun({ id: over.id ?? "11111111-1111-4111-8111-111111111111", trigger: "cron", status: over.status ?? "done", started_at: "2026-11-04T21:00:00Z", finished_at: null }, cands.map((c) => ({ status: c.status ?? "pending", job_state: c.job_state, fail_kind: null })));

beforeEach(() => {
  ack.mockClear();
  window.sessionStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("起動時の収集結果ポップアップ", () => {
  it("新しい完了済みの結果があれば、件数つきで1回だけ表示し、閉じると確認済みにする", async () => {
    notice = sum([{ status: "auto_registered", job_state: "completed" }, { job_state: "review" }, { job_state: "review" }, { status: "failed", job_state: "failed" }]);
    ackIds = [notice.runId];
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    expect(q("run-notice")).not.toBeNull();
    expect(q("run-notice")!.textContent).toContain("11/5 6:00の定期収集");
    expect(q("run-発見")!.textContent).toBe("4件");
    expect(q("run-自動登録")!.textContent).toBe("1件");
    expect(q("run-確認待ち")!.textContent).toBe("2件");
    expect(q("run-取得失敗")!.textContent).toBe("1件");
    expect(q("run-processing")).toBeNull();
    expect(q("run-notice-review")).not.toBeNull(); // 確認待ちへ
    expect(q("run-notice-lotteries")).not.toBeNull(); // 登録された抽選
    expect(q("run-notice-detail")).not.toBeNull();
    await act(async () => q("run-notice-close")!.click());
    expect(ack).toHaveBeenCalledWith(ackIds);
    expect(q("run-notice")).toBeNull();
  });

  it("同じ起動中は再表示しない（セッション内で1回）", async () => {
    notice = sum([{ job_state: "review" }]);
    ackIds = [notice.runId];
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    await act(async () => q("run-notice-close")!.click());
    await act(async () => root.render(createElement(CollectionResultNotice, { key: "again" })));
    await flush();
    expect(q("run-notice")).toBeNull();
  });

  it("処理中の結果は「処理中」と表示し、途中経過であることを示す。確認済みにはしない", async () => {
    notice = sum([{ status: "auto_registered", job_state: "completed" }, { job_state: "pending" }]);
    ackIds = [];
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    expect(q("run-processing")).not.toBeNull();
    expect(q("run-notice")!.textContent).toContain("途中経過");
    expect(q("run-解析待ち")!.textContent).toBe("1件");
    await act(async () => q("run-notice-close")!.click());
    expect(ack).not.toHaveBeenCalled();
  });

  it("表示する結果が無ければ何も出さない", async () => {
    notice = null;
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    expect(q("run-notice")).toBeNull();
  });
});
