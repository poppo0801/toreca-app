import "server-only";
import { AdaptiveScoutBrain } from "@/lib/agent/collection-planner/adaptive";
import { executeInvestigation, type InvestigationRecord } from "@/lib/agent/collection-planner/executor";
import type { AgentLLM } from "@/lib/agent/core";
import type { PlannerWorld } from "@/lib/agent/collection-planner/types";
import { applyPreviews, decideControls, failRun, finishRun, saveMonitorCandidates, startRun, type AppliedSummary } from "@/lib/server/agent/investigation-service";
import { createInvestigationWorld } from "@/lib/server/agent/investigation-world";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 調査を1回実行して記録する（Stage 9D）。画面のアクションとテストが共通で使う入口。
 * 手順: 日次・1回の上限を決める（AIは変更できない）→ 調査（取得→解析→追加調査→照合→評価）→ 記録 →（execute のみ）開発DBへ自動適用。
 * dry_run は、調査の記録（agent_*）以外に何も書かない。自動適用（execute）の許可は呼び出し側（アクション）が環境で確認する。
 */
export type RunInvestigationResult = { ok: true; runId: string; record: InvestigationRecord; applied: AppliedSummary | null } | { ok: false; error: string };

export async function runInvestigation(o: {
  db: Db;
  householdId: string;
  now: Date;
  mode: "dry_run" | "execute";
  live: boolean;
  actor: string | null;
  /** ログインなし（service_role）で実行する場合 */
  asService?: boolean;
  llm?: AgentLLM;
  /** テスト用: 取得・待機の差し替え */
  fetcher?: PlannerWorld["fetchPage"];
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
}): Promise<RunInvestigationResult> {
  const decided = await decideControls(o.db, o.householdId, o.now, { mode: o.mode, realApi: false });
  if (!decided.ok) return { ok: false, error: decided.reason };
  const llm = o.llm ?? new AdaptiveScoutBrain();
  const runId = await startRun(o.db, o.householdId, { mode: o.mode, brain: `${llm.name}（実APIなし）` });
  if (!runId) return { ok: false, error: "調査の記録を作れませんでした" };
  try {
    const { world, drafts } = createInvestigationWorld({ db: o.db, householdId: o.householdId, now: o.now, live: o.live, fetcher: o.fetcher, previous: decided.previous.map((p) => ({ host: p.host, attempts: p.attempts, failures: p.failures, lastFailKind: p.lastFailKind, yielded: p.yielded })) });
    const controls = o.minIntervalMs === undefined ? decided.controls : { ...decided.controls, throttle: { ...decided.controls.throttle, minIntervalMs: o.minIntervalMs } };
    const record = await executeInvestigation({ llm, world, controls, sleep: o.sleep });
    let applied: AppliedSummary | null = null;
    if (o.mode === "execute") {
      const sig = await world.signals();
      const officialUrls = new Set(sig.chains.map((x) => x.officialUrl).filter((u): u is string => !!u).map((u) => new URL(u).hostname.replace(/^www\./, "")));
      const mon = await saveMonitorCandidates(o.db, o.householdId, runId, record, { autoAdd: true });
      const ap = await applyPreviews(o.db, o.householdId, record, drafts, { actor: o.actor, now: o.now, officialUrls, asService: o.asService });
      applied = { monitorAdded: mon.added, monitorCandidates: mon.saved, ...ap };
    } else {
      await saveMonitorCandidates(o.db, o.householdId, runId, record, { autoAdd: false });
    }
    await finishRun(o.db, o.householdId, runId, record, { applied });
    return { ok: true, runId, record, applied };
  } catch (e) {
    await failRun(o.db, runId, (e as Error).message ?? "調査に失敗しました");
    return { ok: false, error: "調査に失敗しました。記録を確認してください" };
  }
}
