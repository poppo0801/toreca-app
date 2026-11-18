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

export async function runAutonomousInCron(o: { db: Db; householdId: string; now: Date; hours: ReadonlyArray<number | null | undefined>; extractor: LotteryExtractor | null }): Promise<AutonomousHookResult> {
  if (process.env.TOREMANE_ENV !== "local") return { status: "disabled" };
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
    const real = realDiscoveryDeps({ env: process.env });
    if (!real.ok) {
      await recordSkippedRun(o.db, o.householdId, o.now, slot, real.reason);
      return { status: "skipped", message: real.reason };
    }
    const world = createRealDiscoveryWorld({ db: o.db, householdId: o.householdId, search: real.search, guard: real.guard });
    const out = await runAutonomousCollection({ db: o.db, householdId: o.householdId, now: o.now, trigger: "cron", actor: null, asService: true, llmFor: real.llmFor, world, real: true, costRecorder: { record: () => undefined }, beforeMission: (m) => real.guard.startCase(m.id), perMissionJpy: real.perMissionJpy, extractor: o.extractor, maxMissions: 1, timeBudgetMs: 40_000 });
    if (out.ok) return { status: "ran", counts: out.counts };
    return "skipped" in out && out.skipped ? { status: "skipped", message: out.reason } : { status: "failed", message: (out as { error: string }).error };
  } catch (e) {
    return { status: "failed", message: ((e as Error).message ?? "").slice(0, 200) };
  }
}

/** 設定画面から、自律型を1回手動で実行する（開発環境のみ） */
export async function runAutonomousManual(o: { db: Db; householdId: string; extractor: LotteryExtractor | null }): Promise<AutonomousHookResult> {
  if (process.env.TOREMANE_ENV !== "local") return { status: "disabled", message: "自律型AI主体は開発環境のみで利用できます" };
  try {
    const { realDiscoveryDeps } = await import("@/lib/server/agent/discovery-real");
    const { runAutonomousCollection } = await import("@/lib/server/agent/discovery-service");
    const { createRealDiscoveryWorld } = await import("@/lib/server/agent/discovery-world");
    const real = realDiscoveryDeps({ env: process.env });
    if (!real.ok) return { status: "skipped", message: `実行できません: ${real.reason}` };
    const world = createRealDiscoveryWorld({ db: o.db, householdId: o.householdId, search: real.search, guard: real.guard });
    const out = await runAutonomousCollection({ db: o.db, householdId: o.householdId, now: new Date(), trigger: "manual", actor: null, llmFor: real.llmFor, world, real: true, costRecorder: { record: () => undefined }, beforeMission: (m) => real.guard.startCase(m.id), perMissionJpy: real.perMissionJpy, extractor: o.extractor, maxMissions: 1, timeBudgetMs: 45_000 });
    if (out.ok) return { status: "ran", counts: out.counts };
    return "skipped" in out && out.skipped ? { status: "skipped", message: out.reason } : { status: "failed", message: (out as { error: string }).error };
  } catch (e) {
    return { status: "failed", message: ((e as Error).message ?? "").slice(0, 200) };
  }
}
