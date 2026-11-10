import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeRun, type RunSummary } from "@/lib/collector/run-summary";

const summaries: RunSummary[] = [];
let notice: RunSummary | null = null;
let ackIds: string[] = [];
const manual: unknown[] = [];
const ack = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
/** 起動時ポップアップの対象プロフィール（固定ID）。サーバー側の判定を模して、対象外のプロフィールには何も返さない */
const TARGET = "00000000-0000-4000-8000-0000000000aa";
let activeProfile = TARGET;
const push = vi.fn();
const asked: (string | undefined)[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: () => undefined }) }));
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ profile: { id: activeProfile } }) }));
vi.mock("@/app/(app)/collection-notice-actions", () => ({
  getRunNoticesAction: async (id?: string) => {
    asked.push(id);
    return id === TARGET ? { summaries, notice, ackIds, manual } : { summaries: [], notice: null, ackIds: [], manual: [] };
  },
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
  push.mockClear();
  asked.length = 0;
  activeProfile = TARGET;
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
    // 簡潔な3項目（新しい抽選候補・自動登録・重複／除外）。「要手動確認」の警告は出さない
    expect(q("brief-新しい抽選候補")!.textContent).toBe("2件");
    expect(q("brief-自動登録")!.textContent).toBe("1件");
    expect(q("brief-重複・除外")!.textContent).toBe("0件");
    expect(q("run-notice")!.textContent).not.toContain("要手動確認");
    expect(q("run-processing")).toBeNull();
    // ボタンは「抽選候補を確認」「閉じる」の2つだけ
    expect([...q("run-notice")!.querySelectorAll("button, a")].map((e) => e.textContent?.trim()).filter((t) => t !== "Close" && t !== "")).toEqual(["閉じる", "抽選候補を確認"]);
    expect(q("run-notice-review")).toBeNull();
    expect(q("run-notice-lotteries")).toBeNull();
    expect(q("run-notice-detail")).toBeNull();
    // 確認済みの記録は表示時に行う（ボタン操作の後ではない）
    expect(ack).toHaveBeenCalledWith(ackIds);
    await act(async () => q("run-notice-close")!.click());
    expect(q("run-notice")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("抽選候補を確認: ポップアップをすぐ閉じ、抽選候補ページへ直接移動する（サーバー処理を待たない）", async () => {
    notice = sum([{ job_state: "review" }]);
    ackIds = [notice.runId];
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    ack.mockClear();
    await act(async () => q("run-notice-confirm")!.click());
    expect(q("run-notice")).toBeNull();
    expect(push).toHaveBeenCalledWith("/lotteries/candidates");
    expect(ack).not.toHaveBeenCalled(); // 遷移の後に追加のサーバー処理を走らせない
  });

  it("対象のプロフィール(固定ID)以外では表示しない。プロフィール名ではなくIDで判定する", async () => {
    notice = sum([{ job_state: "review" }]);
    ackIds = [notice.runId];
    activeProfile = "00000000-0000-4000-8000-0000000000bb";
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    expect(asked).toEqual(["00000000-0000-4000-8000-0000000000bb"]);
    expect(q("run-notice")).toBeNull();
    expect(ack).not.toHaveBeenCalled();
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

  it("表示しない結果（対象外だけの収集など）でも、確認済みにする。次に開いたときに古い結果を出さない", async () => {
    notice = null;
    ackIds = ["11111111-1111-4111-8111-111111111111"];
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    expect(q("run-notice")).toBeNull();
    expect(ack).toHaveBeenCalledWith(ackIds);
  });

  it("要手動確認は起動時のポップアップに出さない（通知・設定の自動収集で確認する）", async () => {
    notice = sum([{ job_state: "review" }]);
    ackIds = [notice.runId];
    manual.push({ id: "m1" });
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    manual.length = 0;
    expect(q("run-notice")).not.toBeNull();
    expect(q("manual-notice-list")).toBeNull();
  });

  it("表示する結果が無ければ何も出さない", async () => {
    notice = null;
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    expect(q("run-notice")).toBeNull();
  });
});
