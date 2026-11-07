import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RowAssess } from "@/lib/collector/assess-row";
import type { Rank } from "@/lib/collector/completeness";

// 画面を開いたまま受付終了を迎えた候補を外す処理（Stage 6N）は、固定の日付の試験データでも動くよう時刻を固定する
vi.mock("@/lib/use-minute-now", () => ({ useMinuteNow: () => new Date("2026-11-04T03:00:00Z") }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ profile: { id: "p1" }, reload: async () => null }) }));
vi.mock("@/components/lottery-form", () => ({ LotteryFormDialog: () => null }));
vi.mock("@/app/(app)/settings/collection/manual-actions", () => ({ manualDismissAction: async () => ({ ok: true }), manualDoneAction: async () => ({ ok: true }), manualRecheckAction: async () => ({ ok: true }) }));

import { AutoCollectView, type CandidateView } from "@/components/auto-collect-view";
import { ManualReviewList, type ManualGroups } from "@/components/manual-review";
import type { ManualItem } from "@/lib/collector/manual-items";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const assess = (rank: Rank): RowAssess => ({ rank, rankLabel: "", missing: "", missingItems: [], conflict: null, priority: { key: "open", label: "受付中", sort: 30, alert: false }, stageLabel: "受付中", tracking: false, related: 0, sourceLabel: "公式X", fields: [], reasons: [], flags: {} });
const cand = (id: string, chain: string): CandidateView =>
  ({ id, source_id: null, title: chain, source_url: `https://x.com/a/status/${id}`, status: "pending", reasons: ["要確認"], draft: { input: { chain: { name: chain }, store: { name: "店" }, items: [{ product: { name: "商品" } }], applyDeadline: { precision: "date_only", date: "2026-11-10" } }, ready: false }, lottery_id: null, fetched_at: `2026-11-0${id}T00:00:00Z`, job_state: "review", kind: "new", due_at: null, assess: assess("B") }) as unknown as CandidateView;
const settings = { prefectures: ["兵庫県", "大阪府", "京都府"], include_online: true, max_distance_km: null, apply_methods: [], receive_methods: [], req_include: [], req_exclude: [], product_mode: "all", product_ids: [], status_mode: "open", track_upcoming: true, auto_register: true, schedule_enabled: true, schedule_hour_jst: 6, x_enabled: false, x_monthly_budget_jpy: 0, x_max_posts_per_run: 10, max_ai_per_run: 8, worker_enabled: true, worker_batch: 6, recheck_hours: 6 };
const props = {
  settings: settings as never,
  sources: [],
  candidates: [cand("1", "系列A"), cand("2", "系列B")],
  counts: { pending: 2, queued: 0, auto_registered: 0, excluded: 0, duplicate: 0, failed: 0 },
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
beforeEach(() => {
  vi.stubGlobal("fetch", async () => ({ json: async () => ({ ok: true }) }));
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click());
};

describe("Stage 6H: 収集候補は展開式（初期は閉じる）", () => {
  const render = async () => {
    root = createRoot(host);
    await act(async () => root!.render(createElement(AutoCollectView, props)));
  };
  it("初期状態は閉じていて、見出しに候補数・要確認件数を表示する。タップで展開できる", async () => {
    await render();
    const block = q('[data-testid="candidates"]')!;
    expect(block.getAttribute("data-open")).toBe("false");
    expect(q('[data-testid="candidates-summary"]')?.textContent).toBe("候補2件・要確認2件");
    await click(q('[data-testid="candidates-toggle"]'));
    expect(block.getAttribute("data-open")).toBe("true");
    expect(q('[data-testid="cand-tab-pending"]')).not.toBeNull();
  });
  it("「編集して登録」のすぐ右に「除外」を置く（この候補だけを除外する既存の操作）", async () => {
    await render();
    await click(q('[data-testid="candidates-toggle"]'));
    const row = q('[data-testid="candidate-row"]')!;
    const edit = row.querySelector('[data-testid="cand-edit"]')!;
    expect(edit.nextElementSibling?.getAttribute("data-testid")).toBe("cand-quick-exclude");
    expect(edit.nextElementSibling?.textContent).toBe("除外");
    // 題名の行には除外ボタンを置かない（同じ操作を重複させない）
    expect(row.querySelectorAll('[data-testid="cand-quick-exclude"]')).toHaveLength(1);
  });
});

describe("Stage 6H: 要手動確認は約3件分の高さで、一覧の中だけスクロールする", () => {
  const item = (i: number): ManualItem => ({ id: `m${i}`, group: "now", urgency: "today", urgencyLabel: "本日締切", dueAt: "2026-11-05T14:59:00Z", title: `候補${i}`, where: `系列${i} 店${i}`, products: ["商品"], shortReason: "店舗を特定できません", reason: "経緯", failLabel: null, sourceUrl: null, editable: true } as unknown as ManualItem);
  const groups = (): ManualGroups => ({ open: [1, 2, 3, 4, 5, 6].map(item), retrying: [], retryingCount: 0, closed: [] });
  it("見出し・件数は一覧の外（固定）、一覧は高さ制限＋内部スクロール＋画面全体へ連鎖しない", async () => {
    root = createRoot(host);
    await act(async () => root!.render(createElement(ManualReviewList, { groups: groups() })));
    const list = q('[data-testid="manual-scroll"]')!;
    expect(list.className).toContain("max-h-[13.5rem]");
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).toContain("overscroll-contain");
    expect(list.className).toContain("touch-pan-y");
    // 件数の見出しはスクロール領域の外にある
    expect(list.contains(q('[data-testid="manual-banner"]'))).toBe(false);
    expect(q('[data-testid="manual-banner"]')?.textContent).toContain("6件");
    // 詳細・対応（詳細画面への導線）は一覧の中に残る
    expect(list.querySelectorAll('[data-testid="manual-detail"]')).toHaveLength(6);
  });
});
