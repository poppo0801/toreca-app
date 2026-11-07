import "server-only";
import type { Db } from "@/lib/server/lottery-service";

export interface SettingsPayload {
  prefectures: string[];
  includeOnline: boolean;
  maxDistanceKm: number | null;
  applyMethods: string[];
  receiveMethods: string[];
  reqInclude: string[];
  reqExclude: string[];
  productMode: "all" | "include" | "exclude";
  productIds: string[];
  statusMode: "open" | "open_or_before";
  trackUpcoming: boolean;
  autoRegister: boolean;
  scheduleEnabled: boolean;
  scheduleHourJst: number;
  scheduleHour2Jst?: number | null;
  xEnabled: boolean;
  xMonthlyBudgetJpy: number;
  xMaxPostsPerRun: number;
  maxAiPerRun: number;
  workerEnabled: boolean;
  workerBatch: number;
  recheckHours: number;
}

/**
 * 自動収集の設定を保存し、**保存された行を読み戻して**返す（Stage 6E）。
 * 更新が0行（対象の設定が無い・権限が無い）のときは、成功として扱わずエラーにする。画面は返された行を、保存済みの値として表示する。
 */
export async function saveCollectionSettings(db: Db, householdId: string, s: SettingsPayload): Promise<{ ok: true; settings: Record<string, unknown> } | { ok: false; error: string }> {
  const { data, error } = await db
    .from("collection_settings")
    .update({
      prefectures: s.prefectures, include_online: s.includeOnline, max_distance_km: s.maxDistanceKm, apply_methods: s.applyMethods, receive_methods: s.receiveMethods,
      req_include: s.reqInclude, req_exclude: s.reqExclude, product_mode: s.productMode, product_ids: s.productIds, status_mode: s.statusMode, track_upcoming: s.trackUpcoming, auto_register: s.autoRegister,
      schedule_enabled: s.scheduleEnabled, schedule_hour_jst: s.scheduleHourJst, schedule_hour2_jst: s.scheduleHour2Jst === s.scheduleHourJst ? null : (s.scheduleHour2Jst ?? null), x_enabled: s.xEnabled, x_monthly_budget_jpy: s.xMonthlyBudgetJpy, x_max_posts_per_run: s.xMaxPostsPerRun,
      max_ai_per_run: s.maxAiPerRun, worker_enabled: s.workerEnabled, worker_batch: s.workerBatch, recheck_hours: s.recheckHours, updated_at: new Date().toISOString(),
    })
    .eq("household_id", householdId)
    .select("*");
  if (error) return { ok: false, error: "保存に失敗しました。もう一度お試しください" };
  if (!data || data.length !== 1) return { ok: false, error: "保存先の設定が見つかりませんでした（保存されていません）。画面を再読み込みしてください" };
  // 保存された値を読み戻して確認する
  const back = (await db.from("collection_settings").select("*").eq("household_id", householdId).maybeSingle()).data;
  if (!back) return { ok: false, error: "保存結果を確認できませんでした。画面を再読み込みして確認してください" };
  return { ok: true, settings: back as Record<string, unknown> };
}
