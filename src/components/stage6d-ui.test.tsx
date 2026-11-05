import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterRows, nextAfter, rankCounts, sortRows, type ReviewRow } from "@/lib/collector/review-list";
import type { RowAssess } from "@/lib/collector/assess-row";
import type { Rank } from "@/lib/collector/completeness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ profile: { id: "p1" }, reload: async () => null }) }));
vi.mock("@/components/lottery-form", () => ({ LotteryFormDialog: () => null }));

import { AutoCollectView, type CandidateView } from "@/components/auto-collect-view";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const assess = (rank: Rank, label: string, sort: number, o: Partial<RowAssess> = {}): RowAssess => ({
  rank, rankLabel: "", missing: rank === "A" ? "" : "商品マスターの確認のみ", missingItems: [], conflict: null, priority: { key: "open", label, sort, alert: sort < 10 }, stageLabel: "受付中", tracking: false, related: 0, sourceLabel: "公式X", fields: [], reasons: ["判定理由"], flags: {}, ...o,
});
const cand = (id: string, chain: string, rank: Rank, label: string, sort: number, extra: Partial<CandidateView> = {}): CandidateView =>
  ({ id, source_id: null, title: chain, source_url: `https://x.com/a/status/${id}`, status: "pending", reasons: ["要確認"], draft: { input: { chain: { name: chain }, store: { name: "店" }, items: [{ product: { name: "商品" } }], applyDeadline: { precision: "date_only", date: "2026-11-10" } }, ready: false }, lottery_id: null, fetched_at: `2026-11-0${id}T00:00:00Z`, job_state: "review", kind: "new", due_at: null, assess: assess(rank, label, sort), ...extra }) as unknown as CandidateView;

const candidates = [
  cand("1", "系列A", "A", "急がない", 70),
  cand("2", "系列B", "B", "受付中", 30),
  cand("3", "系列C", "C", "本日締切", 0, { assess: assess("C", "本日締切", 0, { conflict: "情報源間で食い違う項目: 受取方法" }) }),
  cand("4", "系列D", "D", "自動追跡", 50),
  cand("5", "系列E", "E", "根拠不明", 80),
];

const settings = { prefectures: ["東京都"], include_online: true, max_distance_km: null, apply_methods: [], receive_methods: [], req_include: [], req_exclude: [], product_mode: "all", product_ids: [], status_mode: "open", track_upcoming: true, auto_register: true, schedule_enabled: true, schedule_hour_jst: 6, x_enabled: false, x_monthly_budget_jpy: 0, x_max_posts_per_run: 10, max_ai_per_run: 8, worker_enabled: true, worker_batch: 6, recheck_hours: 6 };
const props = {
  settings: settings as never,
  sources: [],
  candidates,
  counts: { pending: 5, queued: 0, auto_registered: 0, excluded: 0, duplicate: 0, failed: 0 },
  health: { state: "ok", warnings: [], lastCollectAt: null, lastWorkerAt: null, nextCollectAt: null, processing: 0, pausedReason: null, workerDayUsed: 0 } as never,
  ops: { todayDiscovered: 0, todayDiscoveredInitial: 0, todayAi: 0, todayRegistered: 0, monthCostJpy: 0, budgetJpy: 3000, rate: 150, avgPerCallJpy: null, monthCalls: 0, budgetBlocked: false, lastProgressAt: null, dueTodayQueued: 0 },
  stats: [],
  runs: [],
  products: [],
  xConfigured: false,
  aiConfigured: true,
  usage: { xPosts: 0, xCostJpy: 0, aiCalls: 0, newAuto: 0 },
};

let root: Root | null = null;
let host: HTMLDivElement;
let fetchCalls: { body: Record<string, unknown> }[] = [];
beforeEach(() => {
  fetchCalls = [];
  vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    fetchCalls.push({ body });
    if (body.action === "exclude") return { json: async () => ({ ok: true, excluded: 1, prev: [{ id: body.id, prev: { status: "pending", job_state: "review", reasons: ["要確認"] } }] }) };
    if (body.action === "bulkExclude") return { json: async () => ({ ok: true, excluded: 2, failed: 1, prev: [{ id: "1", prev: { status: "pending" } }, { id: "2", prev: { status: "pending" } }] }) };
    if (body.action === "bulkReanalyze") return { json: async () => ({ ok: true, requeued: 2, failed: 1 }) };
    if (body.action === "undoExclude") return { json: async () => ({ ok: true, restored: 1, failed: 0 }) };
    return { json: async () => ({ ok: true }) };
  });
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});
const render = async () => {
  root = createRoot(host);
  await act(async () => root!.render(createElement(AutoCollectView, props)));
};
const rows = () => [...host.querySelectorAll('[data-testid="candidate-row"]')].map((r) => r.textContent ?? "");
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click());
};

describe("Stage 6D: 確認待ちの並べ替え・絞り込み（純関数）", () => {
  const mk = (id: string, rank: Rank, sort: number, dueMs: number | null, at: string): ReviewRow => ({ id, fetched_at: at, dueMs, assess: { rank, priority: { sort } } });
  const list = [mk("a", "A", 70, 5, "2026-11-01"), mk("b", "C", 0, 9, "2026-11-03"), mk("c", "E", 80, null, "2026-11-02"), mk("d", "B", 30, 1, "2026-11-04")];
  it("優先度順（既定）／締切順／情報充実度順／新着順", () => {
    expect(sortRows(list, "priority").map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
    expect(sortRows(list, "deadline").map((r) => r.id)).toEqual(["d", "a", "b", "c"]);
    expect(sortRows(list, "completeness").map((r) => r.id)).toEqual(["a", "d", "b", "c"]);
    expect(sortRows(list, "new").map((r) => r.id)).toEqual(["d", "b", "c", "a"]);
  });
  it("ランクで絞り込み、ランク別の件数を数える", () => {
    expect(filterRows(list, "C").map((r) => r.id)).toEqual(["b"]);
    expect(filterRows(list, "all")).toHaveLength(4);
    expect(rankCounts(list)).toEqual({ all: 4, A: 1, B: 1, C: 1, D: 0, E: 1 });
  });
  it("処理した候補の次に開く候補（後ろ、無ければ前）", () => {
    const l = [{ id: "1" }, { id: "2" }, { id: "3" }];
    expect(nextAfter(l, "1")?.id).toBe("2");
    expect(nextAfter(l, "3")?.id).toBe("2");
    expect(nextAfter([{ id: "1" }], "1")).toBeNull();
  });
});

describe("Stage 6D: 確認待ち画面（ランク・優先度・即時除外・一括操作）", () => {
  it("各候補に A〜E のランク・不足の要約・対応優先度を表示し、初期は対応優先度順（本日締切が先頭）", async () => {
    await render();
    const r = rows();
    expect(r).toHaveLength(5);
    expect(r[0]).toContain("系列C"); // 本日締切（Cランク）が先頭
    expect(r[0]).toContain("本日締切");
    expect(r[0]).toContain("矛盾あり");
    expect(r[r.length - 1]).toContain("系列E");
    expect([...host.querySelectorAll('[data-testid="cand-rank"]')].map((e) => e.getAttribute("data-rank"))).toEqual(["C", "B", "D", "A", "E"]);
    expect(q('[data-testid="cand-missing"]')?.textContent).toContain("不足：商品マスターの確認のみ");
  });
  it("ランクで絞り込める（A〜E・すべて）。件数も表示", async () => {
    await render();
    expect(q('[data-testid="rank-B"]')?.textContent).toContain("1");
    await click(q('[data-testid="rank-B"]'));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("系列B");
    await click(q('[data-testid="rank-all"]'));
    expect(rows()).toHaveLength(5);
  });
  it("並び順を変えられる（情報充実度順では A が先頭）", async () => {
    await render();
    const sel = q('[data-testid="sort-select"]') as HTMLSelectElement;
    await act(async () => {
      sel.value = "completeness";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(rows()[0]).toContain("系列A");
  });
  it("A・Bランクは『編集して登録』を主操作として表示する", async () => {
    await render();
    expect(host.querySelectorAll('[data-testid="cand-edit"]').length).toBe(5);
  });
  it("一覧から即時除外（この候補のみ）→ 取り消し通知 → 元に戻す。収集元の除外ルールは作らない", async () => {
    await render();
    await click(host.querySelectorAll('[data-testid="cand-quick-exclude"]')[0]);
    expect(fetchCalls[0].body).toEqual({ action: "exclude", id: "3" });
    expect(q('[data-testid="undo-toast"]')?.textContent).toContain("除外しました");
    await click(q('[data-testid="undo-button"]'));
    expect(fetchCalls[1].body).toMatchObject({ action: "undoExclude", items: [{ id: "3", prev: { status: "pending" } }] });
    expect(q('[data-testid="undo-toast"]')).toBeNull();
    expect(fetchCalls.some((c) => String(c.body.action).includes("Source") || String(c.body.action).includes("rule"))).toBe(false);
  });
  it("一括除外は対象件数を表示して確認し、選択した候補だけを除外する。結果は成功・失敗の件数で表示", async () => {
    await render();
    const boxes = host.querySelectorAll('[data-testid="cand-select"]');
    await click(boxes[0]);
    await click(boxes[1]);
    await click(q('[data-testid="bulk-exclude"]'));
    expect(q('[data-testid="bulk-confirm"]')?.textContent).toContain("2件");
    expect(fetchCalls).toHaveLength(0); // 確認前は実行しない
    await click(q('[data-testid="bulk-confirm-yes"]'));
    expect(fetchCalls[0].body.action).toBe("bulkExclude");
    expect((fetchCalls[0].body.ids as string[]).length).toBe(2);
    expect(q('[data-testid="collect-msg"]')?.textContent).toContain("成功2件・失敗1件");
    expect(q('[data-testid="undo-toast"]')).not.toBeNull();
  });
  it("一括再調査: 選択した候補を再調査待ちに戻し、成功・失敗の件数を表示", async () => {
    await render();
    await click(host.querySelectorAll('[data-testid="cand-select"]')[0]);
    await click(q('[data-testid="bulk-reanalyze"]'));
    expect(fetchCalls[0].body.action).toBe("bulkReanalyze");
    expect(q('[data-testid="collect-msg"]')?.textContent).toContain("成功2件・失敗1件");
  });
  it("詳細を開くと、判定理由と項目別の出典（確定・未確認・矛盾）を確認できる", async () => {
    const withFields = [cand("9", "系列F", "B", "受付中", 30, { assess: assess("B", "受付中", 30, { fields: [{ key: "applyDeadline", label: "応募締切", value: "2026-11-10", source: "公式X", official: true, state: "confirmed", url: "u" }, { key: "receiveMethod", label: "受取方法", value: "店頭", source: "Xまとめ", official: false, state: "conflict", url: "u2", alt: "配送" }] }) })];
    root = createRoot(host);
    await act(async () => root!.render(createElement(AutoCollectView, { ...props, candidates: withFields })));
    await click(q('[data-testid="cand-detail-toggle"]'));
    const t = q('[data-testid="cand-fields"]')?.textContent ?? "";
    expect(t).toContain("応募締切");
    expect(t).toContain("公式X・確定");
    expect(t).toContain("矛盾（他: 配送）");
    expect(q('[data-testid="cand-detail"]')?.textContent).toContain("判定（B）");
  });
});
