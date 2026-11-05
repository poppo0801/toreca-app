import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { saveCollectionSettings, type SettingsPayload } from "@/lib/server/collector/settings";

const payload: SettingsPayload = { prefectures: ["東京都"], includeOnline: true, maxDistanceKm: null, applyMethods: [], receiveMethods: [], reqInclude: [], reqExclude: [], productMode: "all", productIds: [], statusMode: "open", trackUpcoming: true, autoRegister: true, scheduleEnabled: true, scheduleHourJst: 6, xEnabled: false, xMonthlyBudgetJpy: 0, xMaxPostsPerRun: 10, maxAiPerRun: 8, workerEnabled: true, workerBatch: 6, recheckHours: 6 };

/** 最小のクエリビルダーの偽物（update→eq→select / select→eq→maybeSingle） */
function fakeDb(o: { updateRows: unknown[] | null; updateError?: boolean; readBack: unknown }) {
  return {
    from: () => ({
      update: () => ({ eq: () => ({ select: async () => ({ data: o.updateRows, error: o.updateError ? { message: "x" } : null }) }) }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: o.readBack, error: null }) }) }),
    }),
  } as never;
}

describe("Stage 6E-1: 設定の保存は保存結果まで確認する", () => {
  it("1行更新され読み戻せたら成功。読み戻した値を返す", async () => {
    const r = await saveCollectionSettings(fakeDb({ updateRows: [{}], readBack: { status_mode: "open" } }), "h1", payload);
    expect(r).toEqual({ ok: true, settings: { status_mode: "open" } });
  });
  it("更新が0行（対象なし・権限なし）は成功にしない", async () => {
    const r = await saveCollectionSettings(fakeDb({ updateRows: [], readBack: null }), "h1", payload);
    expect(r.ok).toBe(false);
  });
  it("DBエラーは失敗", async () => {
    const r = await saveCollectionSettings(fakeDb({ updateRows: null, updateError: true, readBack: null }), "h1", payload);
    expect(r.ok).toBe(false);
  });
  it("読み戻せなければ失敗（保存済みと表示しない）", async () => {
    const r = await saveCollectionSettings(fakeDb({ updateRows: [{}], readBack: null }), "h1", payload);
    expect(r.ok).toBe(false);
  });
});
