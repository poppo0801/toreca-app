"use server";

import { revalidatePath } from "next/cache";
import { FIXED_CONTROLS } from "@/lib/agent/collection-planner/controls";
import { canApplyToStoreMaster, isStoreResearchEnabled } from "@/lib/agent/dev-flag";
import { decideControls, loadDailyUsage, type AppliedSummary } from "@/lib/server/agent/investigation-service";
import { runInvestigation } from "@/lib/server/agent/investigation-run";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";
import { createClient } from "@/lib/supabase/server";

/**
 * 情報収集エージェントの調査（開発用の管理画面。Stage 9D）。**開発環境でのみ動く**（本番では拒否）。
 *   dry_run : 調査して結果をプレビューするだけ（登録・追加はしない。既定）
 *   execute : 開発DBへの自動適用（監視候補の自動追加・新規抽選の自動登録・既存抽選の補完）。TOREMANE_ENV=local のときだけ
 * 実APIは使わない（モデルの呼び出し・検索API・画像解析は未承認・未接続）。外部の公開ページの取得は、画面で「外部ページを取得する」を選んだときだけ。
 * 上限（回数・費用・取得・解析・アクセス頻度）は controls.ts が決め、画面・AIからは変更できない。
 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い（開発DBのみのマイグレーション103）
const anyDb = (db: Db) => db as any;

async function ctx(): Promise<{ db: Db; householdId: string } | null> {
  try {
    const db = (await createClient()) as unknown as Db;
    const { data } = await db.auth.getUser();
    if (!data.user) return null;
    const householdId = await currentHouseholdId(db);
    return householdId ? { db, householdId } : null;
  } catch {
    return null;
  }
}

export interface RunRow {
  id: string;
  mode: "dry_run" | "execute";
  brain: string;
  status: "running" | "completed" | "failed" | "stopped" | "limit_reached";
  stopReason: string | null;
  startedAt: string;
  summary: string;
  costJpy: number;
  totalMs: number;
  steps: number;
  fetches: number;
}
export interface StepRow {
  seq: number;
  tool: string;
  purpose: string;
  target: string;
  ok: boolean;
  ms: number;
  costJpy: number;
  resultSummary: string;
  found: { kind: string; title: string; url?: string; detail?: string }[];
  nextInfo: string;
}
export interface CandidateRow {
  id: string;
  kind: "web" | "x";
  name: string;
  url: string;
  official: string;
  relevance: string;
  fetchable: boolean;
  status: "candidate" | "auto_added" | "rejected";
  evidence: string[];
}
export interface RunDetail {
  steps: StepRow[];
  previews: { url: string; recognized: boolean; chainName: string; storeName: string; products: string[]; applyDeadline: string | null; missing: string[]; disposition: { kind: string; reason: string }; registrable: boolean; blockers: string[] }[];
  findings: { kind: string; title: string; url?: string; evidence: string }[];
  rejected: { item: string; reason: string }[];
  stops: string[];
  applied: AppliedSummary | null;
  metrics: Record<string, { value: number | null; basis: string; note?: string }>;
  adjustments: string[];
}

export interface InvestigationContext {
  runs: RunRow[];
  candidates: CandidateRow[];
  usage: { runsToday: number; maxRuns: number; costTodayJpy: number; maxCost: number; analysisRemaining: number; blockedHosts: string[] };
  canExecute: boolean;
}

export async function loadInvestigationAction(): Promise<R<{ context: InvestigationContext }>> {
  if (!isStoreResearchEnabled()) return { ok: false, error: "この画面は開発環境でのみ使えます" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const now = new Date();
  const [runs, cands, usage, decided] = await Promise.all([
    anyDb(c.db).from("agent_investigation_runs").select("id,mode,brain,status,stop_reason,started_at,summary,usage").eq("household_id", c.householdId).order("started_at", { ascending: false }).limit(15),
    anyDb(c.db).from("agent_monitor_candidates").select("id,kind,name,url,official,relevance,fetchable,status,evidence").eq("household_id", c.householdId).order("created_at", { ascending: false }).limit(30),
    loadDailyUsage(c.db, c.householdId, now),
    decideControls(c.db, c.householdId, now, { mode: "dry_run", realApi: false }),
  ]);
  return {
    ok: true,
    context: {
      runs: ((runs.data ?? []) as { id: string; mode: RunRow["mode"]; brain: string; status: RunRow["status"]; stop_reason: string | null; started_at: string; summary: string; usage: { costJpy?: number; totalMs?: number; steps?: number; fetches?: number } | null }[]).map((r) => ({ id: r.id, mode: r.mode, brain: r.brain, status: r.status, stopReason: r.stop_reason, startedAt: r.started_at, summary: r.summary, costJpy: Number(r.usage?.costJpy ?? 0), totalMs: Number(r.usage?.totalMs ?? 0), steps: Number(r.usage?.steps ?? 0), fetches: Number(r.usage?.fetches ?? 0) })),
      candidates: ((cands.data ?? []) as { id: string; kind: "web" | "x"; name: string; url: string; official: string; relevance: string; fetchable: boolean; status: CandidateRow["status"]; evidence: string[] }[]).map((x) => ({ ...x, evidence: Array.isArray(x.evidence) ? x.evidence : [] })),
      usage: { runsToday: usage.runsToday, maxRuns: FIXED_CONTROLS.maxRunsPerDay, costTodayJpy: usage.costTodayJpy, maxCost: FIXED_CONTROLS.maxCostPerDayJpy, analysisRemaining: decided.ok ? decided.controls.analysisRemaining : 0, blockedHosts: decided.blocked },
      canExecute: canApplyToStoreMaster(),
    },
  };
}

export async function loadRunDetailAction(runId: string): Promise<R<{ detail: RunDetail }>> {
  if (!isStoreResearchEnabled()) return { ok: false, error: "この画面は開発環境でのみ使えます" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const [run, steps] = await Promise.all([
    anyDb(c.db).from("agent_investigation_runs").select("result,evaluation").eq("id", runId).eq("household_id", c.householdId).maybeSingle(),
    anyDb(c.db).from("agent_investigation_steps").select("seq,tool,purpose,target,ok,ms,cost_jpy,result_summary,found,next_info").eq("run_id", runId).eq("household_id", c.householdId).order("seq"),
  ]);
  if (!run.data) return { ok: false, error: "調査の記録が見つかりません" };
  const res = (run.data.result ?? {}) as Partial<RunDetail> & { applied?: AppliedSummary | null };
  const ev = (run.data.evaluation ?? {}) as { metrics?: RunDetail["metrics"]; adjustments?: string[] };
  return {
    ok: true,
    detail: {
      steps: ((steps.data ?? []) as { seq: number; tool: string; purpose: string; target: string; ok: boolean; ms: number; cost_jpy: number | string; result_summary: string; found: StepRow["found"]; next_info: string }[]).map((s) => ({ seq: s.seq, tool: s.tool, purpose: s.purpose, target: s.target, ok: s.ok, ms: s.ms, costJpy: Number(s.cost_jpy), resultSummary: s.result_summary, found: Array.isArray(s.found) ? s.found : [], nextInfo: s.next_info })),
      previews: res.previews ?? [],
      findings: res.findings ?? [],
      rejected: res.rejected ?? [],
      stops: res.stops ?? [],
      applied: res.applied ?? null,
      metrics: ev.metrics ?? {},
      adjustments: ev.adjustments ?? [],
    },
  };
}

export async function runInvestigationAction(input: { mode: "dry_run" | "execute"; live: boolean; profileId: string | null }): Promise<R<{ runId: string; status: string; summary: string }>> {
  if (!isStoreResearchEnabled()) return { ok: false, error: "この画面は開発環境でのみ使えます" };
  if (input.mode === "execute" && !canApplyToStoreMaster()) return { ok: false, error: "自動適用は開発環境（TOREMANE_ENV=local）でのみ使えます" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const now = new Date();
  const r = await runInvestigation({ db: c.db, householdId: c.householdId, now, mode: input.mode, live: input.live, actor: input.profileId });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/settings/investigation");
  return { ok: true, runId: r.runId, status: r.record.status, summary: r.record.summary };
}

/** 監視候補の人による確認: 承認＝開発環境の監視対象に追加（Webのみ。Xは本番のAPI設定でのみ取得するため追加しない）／却下＝不採用 */
export async function decideCandidateAction(input: { id: string; accept: boolean }): Promise<R<object>> {
  if (!isStoreResearchEnabled()) return { ok: false, error: "この画面は開発環境でのみ使えます" };
  const c = await ctx();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const { data: cand } = await anyDb(c.db).from("agent_monitor_candidates").select("id,kind,name,url,status").eq("id", input.id).eq("household_id", c.householdId).maybeSingle();
  if (!cand) return { ok: false, error: "候補が見つかりません" };
  if (input.accept) {
    if (!canApplyToStoreMaster()) return { ok: false, error: "監視対象への追加は開発環境（TOREMANE_ENV=local）でのみ使えます" };
    if (cand.kind !== "web") return { ok: false, error: "Xアカウントは、本番のAPI設定の承認後に監視へ追加します（この環境では追加しません）" };
    const ins = await c.db.from("collection_sources").insert({ household_id: c.householdId, kind: "web", name: String(cand.name).slice(0, 80), url: cand.url, adapter: "generic", enabled: true, interval_hours: 24 }).select("id").single();
    if (ins.error && ins.error.code !== "23505") return { ok: false, error: "監視対象に追加できませんでした" };
    await anyDb(c.db).from("agent_monitor_candidates").update({ status: "auto_added", added_source_id: ins.data?.id ?? null, updated_at: new Date().toISOString() }).eq("id", cand.id);
  } else await anyDb(c.db).from("agent_monitor_candidates").update({ status: "rejected", updated_at: new Date().toISOString() }).eq("id", cand.id);
  revalidatePath("/settings/investigation");
  return { ok: true };
}
