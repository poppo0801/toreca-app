import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ profile: { id: "p1" }, reload: async () => null }) }));
vi.mock("@/components/lottery-form", () => ({ LotteryFormDialog: () => null }));

import { AutoCollectView, settingsKey } from "@/components/auto-collect-view";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = { prefectures: ["東京都"], include_online: true, max_distance_km: null, apply_methods: [], receive_methods: [], req_include: [], req_exclude: [], product_mode: "all", product_ids: [], status_mode: "open", track_upcoming: true, auto_register: true, schedule_enabled: true, schedule_hour_jst: 6, x_enabled: false, x_monthly_budget_jpy: 0, x_max_posts_per_run: 10, max_ai_per_run: 8, worker_enabled: true, worker_batch: 6, recheck_hours: 6 };
const src = (id: string) => ({ id, kind: "web", name: `元${id}`, url: "https://example.com/" + id, x_username: null, x_user_id: null, enabled: true, status: "ok", last_attempt_at: null, last_success_at: null, last_item_count: 0, last_new_count: 0, last_result: null, consecutive_failures: 0, error_message: null });
const props = {
  settings: settings as never,
  sources: [src("1"), src("2")] as never,
  candidates: [],
  counts: { pending: 0, queued: 0, auto_registered: 0, excluded: 0, duplicate: 0, failed: 0 },
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
let saveResponse: { ok: boolean; settings?: Record<string, unknown>; error?: string } = { ok: true };
let saved: Record<string, unknown>[] = [];
beforeEach(() => {
  saved = [];
  saveResponse = { ok: true };
  vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { action: string; settings: Record<string, unknown> };
    if (body.action === "saveSettings") {
      saved.push(body.settings);
      return { json: async () => (saveResponse.ok ? { ok: true, settings: saveResponse.settings ?? { ...settings, status_mode: "open_or_before" } } : { ok: false, error: saveResponse.error }) };
    }
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
  await act(async () => (host.querySelector('[data-testid="conditions-toggle"]') as HTMLElement).click());
};
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click());
};
const chip = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;

describe("Stage 6E-1: 収集条件の保存", () => {
  it("初期は『保存済み』で保存ボタンは押せない", async () => {
    await render();
    expect(q('[data-testid="settings-state"]')?.textContent).toBe("保存済み");
    expect((q('[data-testid="save-conditions-inline"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("②で変更すると『未保存の変更があります』と保存ボタンが出て、保存すると保存先の値で『保存済み』に戻る", async () => {
    await render();
    await click(chip("受付前も含む"));
    expect(q('[data-testid="settings-state"]')?.textContent).toBe("未保存の変更があります");
    expect(q('[data-testid="discard-conditions"]')).not.toBeNull();
    await click(q('[data-testid="save-conditions-inline"]'));
    expect(saved).toHaveLength(1);
    expect(saved[0].statusMode).toBe("open_or_before");
    expect(q('[data-testid="settings-state"]')?.textContent).toBe("保存済み");
    expect(q('[data-testid="save-result"]')?.textContent).toContain("保存しました");
  });

  it("保存に失敗したら成功と表示せず、変更を残す", async () => {
    saveResponse = { ok: false, error: "保存に失敗しました。もう一度お試しください" };
    await render();
    await click(chip("受付前も含む"));
    await click(q('[data-testid="save-conditions-inline"]'));
    const r = q('[data-testid="save-result"]');
    expect(r?.textContent).toContain("保存できませんでした");
    expect(r?.getAttribute("role")).toBe("alert");
    expect(q('[data-testid="settings-state"]')?.textContent).toBe("未保存の変更があります");
  });

  it("変更を破棄すると保存済みの値に戻る", async () => {
    await render();
    await click(chip("受付前も含む"));
    await click(q('[data-testid="discard-conditions"]'));
    expect(q('[data-testid="settings-state"]')?.textContent).toBe("保存済み");
  });

  it("閉じている区画にも未保存の変更を表示する", async () => {
    await render();
    await click(chip("受付前も含む"));
    await click(q('[data-testid="conditions-toggle"]'));
    expect(q('[data-testid="conditions-alert"]')?.textContent).toContain("未保存の変更");
  });

  it("収集元は展開式で、初期は閉じており、見出しに件数を出す", async () => {
    await render();
    const d = q('[data-testid="sources"]') as HTMLDetailsElement;
    expect(d.tagName).toBe("DETAILS");
    expect(d.open).toBe(false);
    expect(q('[data-testid="sources-toggle"]')?.textContent).toContain("収集元（2件）");
    expect(q('[data-testid="add-source"]')).not.toBeNull(); // 閉じていても要素は保持される
  });

  it("settingsKey: 配列の順序に依存せず、track_upcoming 未設定は ON と同じ", () => {
    const a = { ...settings, prefectures: ["東京都", "大阪府"] } as never;
    const b = { ...settings, prefectures: ["大阪府", "東京都"] } as never;
    expect(settingsKey(a)).toBe(settingsKey(b));
    const c = { ...settings, track_upcoming: undefined } as never;
    expect(settingsKey(c)).toBe(settingsKey(settings as never));
    expect(settingsKey({ ...settings, status_mode: "open_or_before" } as never)).not.toBe(settingsKey(settings as never));
  });
});
