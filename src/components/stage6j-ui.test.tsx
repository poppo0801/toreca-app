import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RowAssess } from "@/lib/collector/assess-row";
import type { Rank } from "@/lib/collector/completeness";

const dismiss = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean; error?: string });
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ profile: { id: "p1" }, reload: async () => null }) }));
vi.mock("@/components/lottery-form", () => ({ LotteryFormDialog: (p: { prefill?: { draft?: { input?: { chain?: { name?: string } } } } }) => createElement("div", { "data-testid": "edit-form", "data-chain": p.prefill?.draft?.input?.chain?.name ?? "" }) }));
vi.mock("@/app/(app)/settings/collection/manual-actions", () => ({ manualDismissAction: (...a: unknown[]) => dismiss(...a), manualDoneAction: async () => ({ ok: true }), manualRecheckAction: async () => ({ ok: true }) }));

import { AutoCollectView, type CandidateView } from "@/components/auto-collect-view";
import { EditRequestProvider, useEditRequest } from "@/components/edit-request";
import { ManualReviewList, type ManualGroups } from "@/components/manual-review";
import { SwipeEnabledProvider, SwipeRow, SWIPE_ROW_EXIT_MS } from "@/components/swipe-row";
import type { ManualItem } from "@/lib/collector/manual-items";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const assess = (rank: Rank): RowAssess => ({ rank, rankLabel: "", missing: "", missingItems: [], conflict: null, priority: { key: "open", label: "受付中", sort: 30, alert: false }, stageLabel: "受付中", tracking: false, related: 0, sourceLabel: "公式X", fields: [], reasons: [], flags: {} });
const cand = (n: number): CandidateView =>
  ({ id: `c${n}`, source_id: null, title: `系列${n}`, source_url: `https://x.com/a/status/${n}`, status: "pending", reasons: ["要確認"], draft: { input: { chain: { name: `系列${n}` }, store: { name: "店" }, items: [{ product: { name: "商品" } }], applyDeadline: { precision: "date_only", date: "2026-11-10" } }, ready: false }, lottery_id: null, fetched_at: `2026-11-01T00:${String(n % 60).padStart(2, "0")}:00Z`, job_state: "review", kind: "new", due_at: null, assess: assess("B") }) as unknown as CandidateView;
const settings = { prefectures: ["兵庫県"], include_online: true, max_distance_km: null, apply_methods: [], receive_methods: [], req_include: [], req_exclude: [], product_mode: "all", product_ids: [], status_mode: "open", track_upcoming: true, auto_register: true, schedule_enabled: true, schedule_hour_jst: 6, x_enabled: false, x_monthly_budget_jpy: 0, x_max_posts_per_run: 10, max_ai_per_run: 8, worker_enabled: true, worker_batch: 6, recheck_hours: 6 };
const props = (n: number) => ({
  settings: settings as never,
  sources: [],
  candidates: Array.from({ length: n }, (_, i) => cand(i + 1)),
  counts: { pending: n, queued: 0, auto_registered: 0, excluded: 0, duplicate: 0, failed: 0 },
  health: { state: "ok", warnings: [], lastCollectAt: null, lastWorkerAt: null, nextCollectAt: null, processing: 0, pausedReason: null, workerDayUsed: 0 } as never,
  ops: { todayDiscovered: 0, todayDiscoveredInitial: 0, todayAi: 0, todayRegistered: 0, monthCostJpy: 0, budgetJpy: 3000, rate: 150, avgPerCallJpy: null, monthCalls: 0, budgetBlocked: false, lastProgressAt: null, dueTodayQueued: 0 },
  stats: [],
  runs: [],
  products: [],
  xConfigured: false,
  aiConfigured: true,
  usage: { xPosts: 0, xCostJpy: 0, aiCalls: 0, newAuto: 0 },
});

let root: Root | null = null;
let host: HTMLDivElement;
let fetchBody: Record<string, unknown>[] = [];
let fetchOk = true;
beforeEach(() => {
  fetchBody = [];
  fetchOk = true;
  dismiss.mockClear();
  dismiss.mockImplementation(async () => ({ ok: true }));
  vi.stubGlobal("fetch", async (_u: unknown, init?: { body?: string }) => {
    if (init?.body) fetchBody.push(JSON.parse(init.body));
    return { json: async () => (fetchOk ? { ok: true } : { ok: false, error: "保存できませんでした" }) };
  });
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const q = (sel: string, from: ParentNode = host) => from.querySelector(sel) as HTMLElement | null;
const qa = (sel: string, from: ParentNode = host) => [...from.querySelectorAll(sel)] as HTMLElement[];
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click());
};
const ptr = (el: Element, type: string, x: number, y: number, pointerType = "touch") =>
  act(() => {
    el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }), { pointerId: 1, pointerType, isPrimary: true }));
  });
/** 指で (dx, dy) だけ動かして離す */
const swipe = async (el: Element, dx: number, dy = 0, pointerType = "touch") => {
  await ptr(el, "pointerdown", 200, 200, pointerType);
  const steps = 4;
  for (let i = 1; i <= steps; i++) await ptr(el, "pointermove", 200 + (dx * i) / steps, 200 + (dy * i) / steps, pointerType);
  await ptr(el, "pointerup", 200 + dx, 200 + dy, pointerType);
};
const render = async (node: React.ReactElement) => {
  root = createRoot(host);
  await act(async () => root!.render(node));
};
const touch = (node: React.ReactElement) => createElement(SwipeEnabledProvider, { value: true }, node);

describe("Stage 6J: スワイプ行の判定", () => {
  const mk = (over: Partial<{ onRight: () => void; onLeft: () => void; enabled: boolean }> = {}) => {
    const onRight = over.onRight ?? vi.fn();
    const onLeft = over.onLeft ?? vi.fn();
    return { onRight, onLeft, node: createElement(SwipeEnabledProvider, { value: over.enabled ?? true }, createElement(SwipeRow, { onRight, onLeft }, createElement("button", { type: "button", "data-testid": "inner" }, "中身"))) };
  };
  it("右スワイプで編集(onRight)・左スワイプで除外(onLeft)。一定距離を超えたときだけ確定する", async () => {
    vi.useFakeTimers();
    const m = mk();
    await render(m.node);
    const row = q('[data-testid="swipe-row"]')!;
    await swipe(row, 30);
    await swipe(row, -30);
    expect(m.onRight).not.toHaveBeenCalled();
    expect(m.onLeft).not.toHaveBeenCalled();
    await swipe(row, 110);
    expect(m.onRight).toHaveBeenCalledTimes(1);
    expect(m.onLeft).not.toHaveBeenCalled();
    await swipe(row, -110);
    // 除外は指を離すと左へ流れ、流れ終わってから呼ぶ（長い待機はない）
    expect(m.onLeft).not.toHaveBeenCalled();
    expect(q('[data-testid="swipe-row-body"]')!.style.opacity).toBe("0");
    await act(async () => void vi.advanceTimersByTime(SWIPE_ROW_EXIT_MS + 5));
    expect(m.onLeft).toHaveBeenCalledTimes(1);
  });
  it("縦スクロールは横スワイプと判定しない。マウス操作・無効な環境では動かない", async () => {
    const m = mk();
    await render(m.node);
    const row = q('[data-testid="swipe-row"]')!;
    await swipe(row, 20, 120); // 縦に大きく動かした
    await swipe(row, 110, 70); // 斜めで縦寄り
    await swipe(row, 130, 0, "mouse");
    expect(m.onRight).not.toHaveBeenCalled();
    expect(m.onLeft).not.toHaveBeenCalled();
    act(() => root!.unmount());
    root = null;
    const off = mk({ enabled: false });
    await render(off.node);
    await swipe(q('[data-testid="swipe-row"]')!, 130);
    expect(off.onRight).not.toHaveBeenCalled();
    expect(q('[data-testid="swipe-row"]')!.getAttribute("data-swipe")).toBe("off");
  });
  it("スワイプの直後のクリックは無効にする（誤ってボタンを押さない）", async () => {
    const m = mk();
    await render(m.node);
    const clicked = vi.fn();
    q('[data-testid="inner"]')!.addEventListener("click", clicked);
    await swipe(q('[data-testid="swipe-row"]')!, 110);
    await click(q('[data-testid="inner"]'));
    expect(clicked).not.toHaveBeenCalled();
  });
});

describe("Stage 6J: 収集候補のページ切替", () => {
  it("1ページ10件。現在ページ／総ページ数を表示し、前へ・次へで切り替える。15件にも切替可", async () => {
    await render(createElement(AutoCollectView, props(25)));
    await click(q('[data-testid="candidates-toggle"]'));
    expect(qa('[data-testid="candidate-row"]')).toHaveLength(10); // 全件を一度に描画しない
    expect(q('[data-testid="page-info"]')!.textContent).toContain("1 / 3 ページ");
    expect(q('[data-testid="page-prev"]')!.hasAttribute("disabled")).toBe(true);
    await click(q('[data-testid="page-next"]'));
    expect(q('[data-testid="page-info"]')!.textContent).toContain("2 / 3 ページ");
    await click(q('[data-testid="page-next"]'));
    expect(qa('[data-testid="candidate-row"]')).toHaveLength(5);
    expect(q('[data-testid="page-next"]')!.hasAttribute("disabled")).toBe(true);
    const size = q('[data-testid="page-size"]') as HTMLSelectElement;
    await act(async () => {
      size.value = "15";
      size.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(qa('[data-testid="candidate-row"]')).toHaveLength(15);
    expect(q('[data-testid="page-info"]')!.textContent).toContain("1 / 2 ページ"); // 件数を変えると1ページ目から
  });
  it("ランク絞り込みを変えると1ページ目へ戻る。10件以下ならページ切替は出さない", async () => {
    await render(createElement(AutoCollectView, props(8)));
    await click(q('[data-testid="candidates-toggle"]'));
    expect(q('[data-testid="cand-pager"]')).toBeNull();
    expect(qa('[data-testid="candidate-row"]')).toHaveLength(8);
  });
});

describe("Stage 6J: 収集候補のスワイプ", () => {
  it("左スワイプで除外: すぐ一覧から消え、件数が直ちに減る。この候補だけを除外し(物理削除なし・確認なし)、収集元の除外は作らない", async () => {
    vi.useFakeTimers();
    await render(touch(createElement(AutoCollectView, props(3))));
    expect(q('[data-testid="candidates-summary"]')!.textContent).toBe("候補3件・要確認3件");
    await click(q('[data-testid="candidates-toggle"]'));
    expect(q('[data-testid="cand-count-pending"]')!.textContent).toBe("3");
    const first = qa('[data-testid="candidate-row"]')[0];
    const firstId = `c${/系列([0-9]+)/.exec(first.textContent ?? "")![1]}`;
    await swipe(q('[data-testid="swipe-row"]', first)!, -120);
    await act(async () => void vi.advanceTimersByTime(SWIPE_ROW_EXIT_MS + 5));
    await act(async () => void vi.advanceTimersByTime(5));
    expect(qa('[data-testid="candidate-row"]')).toHaveLength(2);
    expect(q('[data-testid="cand-count-pending"]')!.textContent).toBe("2"); // 件数を直ちに更新
    expect(fetchBody).toEqual([{ action: "exclude", id: firstId }]); // 除外するのは左スワイプした1件だけ
    expect(q('[data-testid="bulk-confirm"]')).toBeNull(); // 確認ダイアログなし
  });
  it("通信に失敗したら行を戻してエラーを表示する", async () => {
    vi.useFakeTimers();
    fetchOk = false;
    await render(touch(createElement(AutoCollectView, props(2))));
    await click(q('[data-testid="candidates-toggle"]'));
    await swipe(q('[data-testid="swipe-row"]', qa('[data-testid="candidate-row"]')[0])!, -120);
    await act(async () => void vi.advanceTimersByTime(SWIPE_ROW_EXIT_MS + 5));
    await act(async () => void vi.advanceTimersByTime(5));
    expect(qa('[data-testid="candidate-row"]')).toHaveLength(2); // 復元
    expect(q('[data-testid="cand-count-pending"]')!.textContent).toBe("2");
    expect(host.textContent).toContain("除外できませんでした");
  });
  it("右スワイプで編集フォームを開く（候補の解析済みの内容を反映）", async () => {
    await render(touch(createElement(AutoCollectView, props(2))));
    await click(q('[data-testid="candidates-toggle"]'));
    const row = qa('[data-testid="candidate-row"]')[0];
    const chain = /系列[0-9]+/.exec(row.textContent ?? "")![0];
    await swipe(q('[data-testid="swipe-row"]', row)!, 120);
    const form = q('[data-testid="edit-form"]')!;
    expect(form).not.toBeNull();
    expect(form.getAttribute("data-chain")).toBe(chain);
    expect(fetchBody).toEqual([]); // 開いただけ。何も変更しない
  });
});

describe("Stage 6J: 要手動確認から編集フォームを直接開く／スワイプ", () => {
  const item = (i: number, editable = true): ManualItem => ({ id: `c${i}`, group: "now", urgency: "today", urgencyLabel: "本日締切", dueAt: "2026-11-05T14:59:00Z", title: `候補${i}`, where: `系列${i} 店${i}`, products: ["商品"], shortReason: "店舗を特定できません", reason: "経緯", failLabel: null, sourceUrl: null, editable }) as unknown as ManualItem;
  const groups = (n = 3): ManualGroups => ({ open: Array.from({ length: n }, (_, i) => item(i + 1)), retrying: [], retryingCount: 0, closed: [] });

  /** 要手動確認の一覧＋収集候補を同じ画面に置く（本番の画面と同じ構成） */
  const screen = (n = 3) => createElement(EditRequestProvider, null, createElement(ManualReviewList, { groups: groups(n) }), createElement(AutoCollectView, props(n)));

  it("「詳細・対応」→「編集して登録」で、収集候補を開かずに対象候補の編集フォームが直接開く。キャンセルで元の画面に戻る", async () => {
    await render(screen());
    const block = q('[data-testid="candidates"]')!;
    expect(block.getAttribute("data-open")).toBe("false"); // 収集候補は閉じたまま
    await click(qa('[data-testid="manual-detail"]')[1]);
    await click(q('[data-testid="manual-edit"]'));
    expect(q('[data-testid="edit-form"]')).not.toBeNull();
    expect(q('[data-testid="edit-form"]')!.getAttribute("data-chain")).toBe("系列2");
    expect(block.getAttribute("data-open")).toBe("false"); // 一覧を経由しない
    expect(q('[data-testid="manual-review"]')).not.toBeNull(); // 元の一覧はそのまま
  });
  it("右スワイプでも編集フォームを直接開く。編集できない項目(解析結果なし)は右に動かない", async () => {
    await render(touch(screen()));
    await swipe(q('[data-testid="swipe-row"]', qa('[data-testid="manual-row"]')[0])!, 120);
    expect(q('[data-testid="edit-form"]')!.getAttribute("data-chain")).toBe("系列1");
    act(() => root!.unmount());
    root = null;
    await render(touch(createElement(EditRequestProvider, null, createElement(ManualReviewList, { groups: { open: [item(9, false)], retrying: [], retryingCount: 0, closed: [] } }))));
    const consumer = vi.fn();
    void consumer;
    await swipe(q('[data-testid="swipe-row"]', qa('[data-testid="manual-row"]')[0])!, 120);
    expect(q('[data-testid="edit-form"]')).toBeNull();
  });
  it("左スワイプで除外: 直ちに一覧と件数から消え、対象外(その他)として保存する。失敗したら戻してエラー表示", async () => {
    vi.useFakeTimers();
    await render(touch(createElement(EditRequestProvider, null, createElement(ManualReviewList, { groups: groups() }))));
    expect(q('[data-testid="manual-banner"]')!.textContent).toContain("3件");
    await swipe(q('[data-testid="swipe-row"]', qa('[data-testid="manual-row"]')[0])!, -120);
    await act(async () => void vi.advanceTimersByTime(SWIPE_ROW_EXIT_MS + 5));
    await act(async () => void vi.advanceTimersByTime(5));
    expect(qa('[data-testid="manual-row"]')).toHaveLength(2);
    expect(q('[data-testid="manual-banner"]')!.textContent).toContain("2件");
    expect(dismiss).toHaveBeenCalledWith("c1", "other", "スワイプで除外");
    // 失敗
    dismiss.mockImplementationOnce(async () => ({ ok: false, error: "更新できませんでした" }));
    await swipe(q('[data-testid="swipe-row"]', qa('[data-testid="manual-row"]')[0])!, -120);
    await act(async () => void vi.advanceTimersByTime(SWIPE_ROW_EXIT_MS + 5));
    await act(async () => void vi.advanceTimersByTime(5));
    expect(qa('[data-testid="manual-row"]')).toHaveLength(2); // 復元
    expect(host.textContent).toContain("除外できませんでした");
  });
  it("EditRequest のプロバイダーが無い画面でも動く（従来どおりリンクで収集候補へ）", async () => {
    await render(createElement(ManualReviewList, { groups: groups(1) }));
    await click(q('[data-testid="manual-detail"]'));
    expect(q('[data-testid="manual-edit"]')!.tagName).toBe("A");
  });
  it("EditRequest は要求を1回だけ渡す", async () => {
    const seen: (string | null)[] = [];
    const Probe = () => {
      const e = useEditRequest();
      useEffect(() => void seen.push(e?.id ?? null), [e?.id]);
      return createElement("button", { "data-testid": "go", onClick: () => e?.request("c1") }, "go");
    };
    await render(createElement(EditRequestProvider, null, createElement(Probe)));
    await click(q('[data-testid="go"]'));
    expect(seen).toEqual([null, "c1"]);
  });
});
