import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import { computeAlerts, planNotifications } from "@/lib/notifications";
import { UNKNOWN_DATE } from "@/lib/datetime";
import type { Caution } from "@/lib/collector/attention";
import type { AppData, Lottery } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
const actions = { setManaged: vi.fn(), setApplied: vi.fn(), setResult: vi.fn(), setFulfillment: vi.fn() };
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], settings: {}, actions, persistent: true, reload: async () => {} }),
}));
vi.mock("@/components/lottery-detail-sheet", () => ({ LotteryDetailSheet: () => null }));

import { LotteryCard } from "@/components/lottery-card";
import { CautionMark } from "@/components/caution-mark";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const caution = (code: string, message: string): Caution => ({ code, field: "resultDate", message, at: NOW.toISOString() });
let root: Root;
let host: HTMLDivElement;
const patch = (id: string, p: Partial<Lottery>) => {
  data = { ...data, lotteries: data.lotteries.map((l) => (l.id === id ? { ...l, ...p } : l)) };
};
const mount = (id: string, view: "simple" | "detail") => {
  const lottery = data.lotteries.find((l) => l.id === id)!;
  act(() => {
    root.render(createElement(LotteryCard, { lottery, tab: "all", view }));
  });
};
const q = (sel: string) => host.querySelector<HTMLElement>(sel);

beforeEach(() => {
  data = createMockData(NOW);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Stage 7A: 注意アイコン", () => {
  it("注意付きの抽選にだけ小さなアイコンを出す（詳細・コンパクトとも）。通常の抽選には出さない", () => {
    for (const view of ["detail", "simple"] as const) {
      mount("L1", view);
      expect(q('[data-testid="caution-mark"]'), `${view}: 通常`).toBeNull();
      patch("L1", { cautions: [caution("result_date_unknown", "当選発表日が確認できていません")] });
      mount("L1", view);
      const mark = q('[data-testid="caution-mark"]')!;
      expect(mark, view).not.toBeNull();
      expect(mark.getAttribute("aria-label")).toContain("当選発表日が確認できていません");
      patch("L1", { cautions: [] });
    }
  });
  it("NEW・★・応募状態と重ならない位置（店舗名の行の中）にあり、カードの高さを増やす行を追加しない", () => {
    patch("L1", { cautions: [caution("store_unconfirmed", "受取店舗が確定していません")], isNew: true });
    mount("L1", "detail");
    const mark = q('[data-testid="caution-mark"]')!;
    expect(mark.closest('[data-testid="card-place"]')).not.toBeNull();
    expect(mark.closest('[data-testid="card-star"]')).toBeNull();
    expect(host.textContent).toContain("NEW");
    expect(host.querySelectorAll('[data-testid="caution-mark"]')).toHaveLength(1);
  });
  it("CautionMark は注意が空・未設定なら何も描画しない", () => {
    act(() => root.render(createElement(CautionMark, { cautions: [] })));
    expect(host.innerHTML).toBe("");
    act(() => root.render(createElement(CautionMark, { cautions: undefined })));
    expect(host.innerHTML).toBe("");
  });
});

describe("Stage 7A: 不明な日時から誤った通知を作らない", () => {
  it("当選発表日・購入期間が不明な注意付き抽選でも、不明な日時を推測した通知（予定・アラート）は作らない", () => {
    patch("L4", { cautions: [caution("result_date_unknown", "当選発表日が確認できていません")], resultDate: UNKNOWN_DATE, procedureStart: UNKNOWN_DATE, procedureDeadline: UNKNOWN_DATE, receiveStart: UNKNOWN_DATE, receiveDeadline: UNKNOWN_DATE });
    const plan = planNotifications(data, {}, NOW);
    const bad = plan.due.filter((n) => n.lotteryId === "L4" && /result|pickup|purchase|receive/.test(n.type));
    expect(bad).toHaveLength(0);
    for (const p of data.profiles) {
      const alerts = computeAlerts(data, p.id, NOW).filter((a) => a.lotteryId === "L4" && /result|pickup|purchase|receive/.test(a.kind));
      expect(alerts).toHaveLength(0);
    }
  });
});
