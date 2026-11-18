import "server-only";
import type { LotteryExtractor } from "@/lib/ai/provider";
import { autonomousCaps, autonomousSlotDecision, autonomousTimeBudget, isBusyPeriod, MAX_MISSIONS_PER_OPPORTUNITY, opportunityHours, paceDecision, slotKeyOf, slotWorthContinuing } from "@/lib/collector/engine-setting";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 定期実行・手動実行から、自律型AI主体の収集を呼び出す口（Stage 9H-3Q）。grouping-hook.ts・investigation-hook.ts と同じ作り。
 *  - **開発環境（TOREMANE_ENV=local）だけ**で動く。本番（Vercel）では何もせず、収集の動作は変わらない（先頭の判定で即座に戻る）。
 *  - 自律探索のコード（AI・検索・取得・検証層）は、環境の判定を通ったあとに初めて読み込む（本番では読み込まれない）。
 *  - 実AIの関門（real-gate.ts＋累計上限＋確認）を通らなければ実行せず、「開始できなかった」理由を調査履歴に記録する（利用者に見える。従来方式へ自動では切り替えない）。
 *  - 失敗しても収集全体（ワーカー・位置情報など）は止めない。
 */
export type AutonomousHookResult = { status: "disabled" | "not_due" | "ran" | "skipped" | "failed"; message?: string; counts?: { found: number; registered: number; duplicates: number } };

export interface BudgetState {
  /** いま使える残り（日次・月次の小さい方）。0 以上 */
  remaining: number;
  dailyRemaining: number;
  monthlyRemaining: number;
}

/**
 * 本番の費用管理: 調査履歴（DB）に記録された費用から、今日（日本時間）・今月の残り予算を計算する。
 * 上限は環境変数（AUTONOMOUS_DAILY_CAP_JPY 既定100円／AUTONOMOUS_MONTHLY_CAP_JPY 既定1,500円）。
 * 実行中の記録（まだ費用が確定していない）は、1件の上限額を消費したものとして安全側に数える（同時実行・途中終了で予算を超えない）。
 * 読み取れなければ undefined（有料の実行は開始しない）。開発環境では、従来どおりファイルの台帳（累計上限）を使うため、この計算は使わない。
 */
export async function budgetState(db: Db, householdId: string, now: Date, env: Record<string, string | undefined> = process.env): Promise<BudgetState | undefined> {
  const caps = autonomousCaps(env);
  const jst = new Date(now.getTime() + 9 * 3600_000).toISOString();
  const dayStart = new Date(`${jst.slice(0, 10)}T00:00:00+09:00`).toISOString();
  const monthStart = new Date(`${jst.slice(0, 7)}-01T00:00:00+09:00`).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い（マイグレーション105）
  const { data, error } = await (db as any).from("discovery_runs").select("cost_jpy,started_at,status").eq("household_id", householdId).gte("started_at", monthStart).limit(5000);
  if (error) return undefined;
  const rows = (data ?? []) as { cost_jpy: number; started_at: string; status: string }[];
  const cost = (r: { cost_jpy: number; status: string }) => (r.status === "running" ? Math.max(Number(r.cost_jpy ?? 0), caps.perMissionJpy) : Number(r.cost_jpy ?? 0));
  const month = rows.reduce((a, r) => a + cost(r), 0);
  const day = rows.filter((r) => r.started_at >= dayStart).reduce((a, r) => a + cost(r), 0);
  const dailyRemaining = Math.max(0, caps.dailyJpy - day);
  const monthlyRemaining = Math.max(0, caps.monthlyJpy - month);
  return { remaining: Math.min(dailyRemaining, monthlyRemaining), dailyRemaining, monthlyRemaining };
}

export async function budgetRemainingJpy(db: Db, householdId: string, now: Date, env: Record<string, string | undefined> = process.env): Promise<number | undefined> {
  return (await budgetState(db, householdId, now, env))?.remaining;
}

export async function runAutonomousInCron(o: { db: Db; householdId: string; now: Date; /** 互換のため残す（調査機会は発売日の近さから決める） */ hours?: ReadonlyArray<number | null | undefined>; extractor: LotteryExtractor | null }): Promise<AutonomousHookResult> {
  // 開発環境、または本番で明示的に許可（AUTONOMOUS_COLLECTION=on）されたときだけ。それ以外は何もしない（探索のコードも読み込まない）
  if (process.env.TOREMANE_ENV !== "local" && process.env.AUTONOMOUS_COLLECTION !== "on") return { status: "disabled" };
  try {
    // 調査機会: 新商品の発売前後の繁忙期は多く、通常は少なく。発売日は商品マスターから読む（店舗・系列・検索語は決めない）
    const today = new Date(o.now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
    const day0 = Date.parse(`${today}T00:00:00Z`);
    const rel = await o.db.from("products").select("release_date").eq("household_id", o.householdId).not("release_date", "is", null).gte("release_date", new Date(day0 - 3 * 86_400_000).toISOString().slice(0, 10)).lte("release_date", new Date(day0 + 7 * 86_400_000).toISOString().slice(0, 10)).limit(50);
    const busy = isBusyPeriod(today, (rel.data ?? []).map((p) => p.release_date as string | null));
    const hours = opportunityHours(busy);
    const slot = slotKeyOf(o.now, hours);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い（マイグレーション105）
    const inSlot = (await (o.db as any).from("discovery_runs").select("id,status,started_at,cost_jpy,counts").eq("household_id", o.householdId).eq("slot", slot).neq("status", "skipped").order("started_at")) as { data: { status: string; started_at: string; cost_jpy: number; counts: { found?: number; registered?: number; held?: number } | null }[] | null };
    const runs = inSlot.data ?? [];
    const running = runs.find((r) => r.status === "running");
    const dec = autonomousSlotDecision({ now: o.now, hours, runsInSlot: runs.length, runningSince: running ? new Date(running.started_at) : null, maxRuns: MAX_MISSIONS_PER_OPPORTUNITY });
    if (!dec.due) return { status: "not_due", message: dec.reason };
    const worth = slotWorthContinuing({ busy, previous: runs.map((r) => ({ status: r.status, found: Number(r.counts?.found ?? 0), registered: Number(r.counts?.registered ?? 0), held: Number(r.counts?.held ?? 0) })) });
    if (!worth.ok) return { status: "not_due", message: worth.reason };
    const isLocal = process.env.TOREMANE_ENV === "local";
    const state = isLocal ? undefined : await budgetState(o.db, o.householdId, o.now);
    if (!isLocal) {
      const caps = autonomousCaps(process.env);
      const slotsLeft = hours.filter((h) => h > Number(slot.slice(-2))).length + 1;
      const pace = state ? paceDecision({ dailyRemaining: state.dailyRemaining, monthlyRemaining: state.monthlyRemaining, slotSpent: runs.reduce((a, r) => a + Number(r.cost_jpy ?? 0), 0), slotsLeftToday: slotsLeft, perMissionJpy: caps.perMissionJpy }) : { ok: false, reason: "費用の記録を読み取れないため、有料の調査は開始しません" };
      if (!pace.ok) {
        const { recordSkippedRun } = await import("@/lib/server/agent/discovery-service");
        await recordSkippedRun(o.db, o.householdId, o.now, slot, pace.reason);
        return { status: "skipped", message: pace.reason };
      }
    }
    const { realDiscoveryDeps } = await import("@/lib/server/agent/discovery-real");
    const { runAutonomousCollection, recordSkippedRun } = await import("@/lib/server/agent/discovery-service");
    const { createRealDiscoveryWorld } = await import("@/lib/server/agent/discovery-world");
    const real = realDiscoveryDeps({ env: process.env, budgetRemainingJpy: isLocal ? undefined : state?.remaining });
    if (!real.ok) {
      await recordSkippedRun(o.db, o.householdId, o.now, slot, real.reason);
      return { status: "skipped", message: real.reason };
    }
    const world = createRealDiscoveryWorld({ db: o.db, householdId: o.householdId, search: real.search, guard: real.guard });
    const tb = autonomousTimeBudget(process.env);
    const out = await runAutonomousCollection({ db: o.db, householdId: o.householdId, now: o.now, trigger: "cron", actor: null, asService: true, llmFor: real.llmFor, world, real: true, costRecorder: { record: () => undefined }, costSoFar: () => real.guard.spentJpy, beforeMission: (m) => real.guard.startCase(m.id), perMissionJpy: real.perMissionJpy, extractor: o.extractor, maxMissions: 1, timeBudgetMs: tb.missionMs, totalBudgetMs: tb.totalMs, slot });
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
    const out = await runAutonomousCollection({ db: o.db, householdId: o.householdId, now: new Date(), trigger: "manual", actor: null, llmFor: real.llmFor, world, real: true, costRecorder: { record: () => undefined }, costSoFar: () => real.guard.spentJpy, beforeMission: (m) => real.guard.startCase(m.id), perMissionJpy: real.perMissionJpy, extractor: o.extractor, maxMissions: 1, timeBudgetMs: autonomousTimeBudget(process.env).missionMs, totalBudgetMs: autonomousTimeBudget(process.env).totalMs });
    if (out.ok) return { status: "ran", counts: out.counts };
    return "skipped" in out && out.skipped ? { status: "skipped", message: out.reason } : { status: "failed", message: (out as { error: string }).error };
  } catch (e) {
    return { status: "failed", message: ((e as Error).message ?? "").slice(0, 200) };
  }
}
