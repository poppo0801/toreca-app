import "server-only";
import type { LotteryExtractor } from "@/lib/ai/provider";
import { autonomousSlotDecision, slotKeyOf } from "@/lib/collector/engine-setting";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 定期実行・手動実行から、自律型AI主体の収集を呼び出す口（Stage 9H-3Q）。grouping-hook.ts・investigation-hook.ts と同じ作り。
 *  - **開発環境（TOREMANE_ENV=local）だけ**で動く。本番（Vercel）では何もせず、収集の動作は変わらない（先頭の判定で即座に戻る）。
 *  - 自律探索のコード（AI・検索・取得・検証層）は、環境の判定を通ったあとに初めて読み込む（本番では読み込まれない）。
 *  - 実AIの関門（real-gate.ts＋累計上限＋確認）を通らなければ実行せず、「開始できなかった」理由を調査履歴に記録する（利用者に見える。従来方式へ自動では切り替えない）。
 *  - 失敗しても収集全体（ワーカー・位置情報など）は止めない。
 */
export type AutonomousHookResult = { status: "disabled" | "not_due" | "ran" | "skipped" | "failed"; message?: string; counts?: { found: number; registered: number; duplicates: number } };

/**
 * 本番の費用管理: 調査履歴（DB）に記録された費用から、今日（日本時間）・今月の残り予算を計算する。
 * 上限は環境変数（AUTONOMOUS_DAILY_CAP_JPY 既定30円／AUTONOMOUS_MONTHLY_CAP_JPY 既定300円）。読み取れなければ undefined（有料の実行は開始しない）。
 * 開発環境では、従来どおりファイルの台帳（累計上限）を使うため、この計算は使わない。
 */
export async function budgetRemainingJpy(db: Db, householdId: string, now: Date, env: Record<string, string | undefined> = process.env): Promise<number | undefined> {
  const daily = Number(env.AUTONOMOUS_DAILY_CAP_JPY) > 0 ? Number(env.AUTONOMOUS_DAILY_CAP_JPY) : 30;
  const monthly = Number(env.AUTONOMOUS_MONTHLY_CAP_JPY) > 0 ? Number(env.AUTONOMOUS_MONTHLY_CAP_JPY) : 300;
  const jst = new Date(now.getTime() + 9 * 3600_000).toISOString();
  const dayStart = new Date(`${jst.slice(0, 10)}T00:00:00+09:00`).toISOString();
  const monthStart = new Date(`${jst.slice(0, 7)}-01T00:00:00+09:00`).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い（マイグレーション104）
  const { data, error } = await (db as any).from("discovery_runs").select("cost_jpy,started_at").eq("household_id", householdId).gte("started_at", monthStart).limit(5000);
  if (error) return undefined;
  const rows = (data ?? []) as { cost_jpy: number; started_at: string }[];
  const month = rows.reduce((a, r) => a + Number(r.cost_jpy ?? 0), 0);
  const day = rows.filter((r) => r.started_at >= dayStart).reduce((a, r) => a + Number(r.cost_jpy ?? 0), 0);
  return Math.max(0, Math.min(daily - day, monthly - month));
}

export async function runAutonomousInCron(o: { db: Db; householdId: string; now: Date; hours: ReadonlyArray<number | null | undefined>; extractor: LotteryExtractor | null }): Promise<AutonomousHookResult> {
  // 開発環境、または本番で明示的に許可（AUTONOMOUS_COLLECTION=on）されたときだけ。それ以外は何もしない（探索のコードも読み込まない）
  if (process.env.TOREMANE_ENV !== "local" && process.env.AUTONOMOUS_COLLECTION !== "on") return { status: "disabled" };
  try {
    const slot = slotKeyOf(o.now, o.hours);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い（マイグレーション104）
    const inSlot = (await (o.db as any).from("discovery_runs").select("id,status,started_at").eq("household_id", o.householdId).eq("slot", slot).neq("status", "skipped")) as { data: { status: string; started_at: string }[] | null };
    const running = (inSlot.data ?? []).find((r) => r.status === "running");
    const dec = autonomousSlotDecision({ now: o.now, hours: o.hours, runsInSlot: (inSlot.data ?? []).length, runningSince: running ? new Date(running.started_at) : null });
    if (!dec.due) return { status: "not_due", message: dec.reason };
    const { realDiscoveryDeps } = await import("@/lib/server/agent/discovery-real");
    const { runAutonomousCollection, recordSkippedRun } = await import("@/lib/server/agent/discovery-service");
    const { createRealDiscoveryWorld } = await import("@/lib/server/agent/discovery-world");
    const real = realDiscoveryDeps({ env: process.env, budgetRemainingJpy: process.env.TOREMANE_ENV === "local" ? undefined : await budgetRemainingJpy(o.db, o.householdId, o.now) });
    if (!real.ok) {
      await recordSkippedRun(o.db, o.householdId, o.now, slot, real.reason);
      return { status: "skipped", message: real.reason };
    }
    const world = createRealDiscoveryWorld({ db: o.db, householdId: o.householdId, search: real.search, guard: real.guard });
    const out = await runAutonomousCollection({ db: o.db, householdId: o.householdId, now: o.now, trigger: "cron", actor: null, asService: true, llmFor: real.llmFor, world, real: true, costRecorder: { record: () => undefined }, costSoFar: () => real.guard.spentJpy, beforeMission: (m) => real.guard.startCase(m.id), perMissionJpy: real.perMissionJpy, extractor: o.extractor, maxMissions: 1, timeBudgetMs: 35_000 });
    if (out.ok) return { status: "ran", counts: out.counts };
    return "skipped" in out && out.skipped ? { status: "skipped", message: out.reason } : { status: "failed", message: (out as { error: string }).error };
  } catch (e) {
    return { status: "failed", message: ((e as Error).message ?? "").slice(0, 200) };
  }
}

/** 設定画面から、自律型を1回手動で実行する（開発環境のみ） */
export async function runAutonomousManual(o: { db: Db; householdId: string; extractor: LotteryExtractor | null }): Promise<AutonomousHookResult> {
  if (process.env.TOREMANE_ENV !== "local" && process.env.AUTONOMOUS_COLLECTION !== "on") return { status: "disabled", message: "自律型AI主体はこの環境で有効になっていません" };
  try {
    const { realDiscoveryDeps } = await import("@/lib/server/agent/discovery-real");
    const { runAutonomousCollection } = await import("@/lib/server/agent/discovery-service");
    const { createRealDiscoveryWorld } = await import("@/lib/server/agent/discovery-world");
    const real = realDiscoveryDeps({ env: process.env, budgetRemainingJpy: process.env.TOREMANE_ENV === "local" ? undefined : await budgetRemainingJpy(o.db, o.householdId, new Date()) });
    if (!real.ok) return { status: "skipped", message: `実行できません: ${real.reason}` };
    const world = createRealDiscoveryWorld({ db: o.db, householdId: o.householdId, search: real.search, guard: real.guard });
    const out = await runAutonomousCollection({ db: o.db, householdId: o.householdId, now: new Date(), trigger: "manual", actor: null, llmFor: real.llmFor, world, real: true, costRecorder: { record: () => undefined }, costSoFar: () => real.guard.spentJpy, beforeMission: (m) => real.guard.startCase(m.id), perMissionJpy: real.perMissionJpy, extractor: o.extractor, maxMissions: 1, timeBudgetMs: 45_000 });
    if (out.ok) return { status: "ran", counts: out.counts };
    return "skipped" in out && out.skipped ? { status: "skipped", message: out.reason } : { status: "failed", message: (out as { error: string }).error };
  } catch (e) {
    return { status: "failed", message: ((e as Error).message ?? "").slice(0, 200) };
  }
}
