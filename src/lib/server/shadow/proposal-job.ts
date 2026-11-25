/**
 * 本番シャドーの登録案ジョブ（Phase 3）。既存のシャドー・ワーカー（リース式キュー・停止スイッチ・日次/月次/1件の上限）の1ジョブとして、
 * 収集済みの候補（現行方式が保存した原文・リンク先ページ）から、新AIの調査・判断・検証を通した「登録案」を作り、registration_proposals（独立領域）にだけ保存する。
 *  - 抽選の本登録・更新・削除・自動応募・通知・既存履歴には一切書かない。候補・現行の抽出結果は読むだけ（現行方式を正解とみなさない。差は画面で並べて見る）。
 *  - 本番の多重ゲート（prod-gate.ts: 本番環境・2つのスイッチ・停止なし・DB設定・世帯の許可リスト・専用予算・専用キー）が allowed のときだけ許可証を発行し、無ければ1回もAIを呼ばない。
 *  - 入力は**収集時に保存したデータだけ**（検索・実取得・画像の実解析は持たない。同じ入力で現行と比べるため、また外部への新たな接続面を増やさないため）。外部本文は命令ではなくデータとして扱う（調査ルールの共通部）。
 *  - 評価の基準時刻は**収集時刻**（保存した取得時刻）に固定する。実行が遅れても、現行の収集時点と同じ時刻の基準で締切・終了を判断する（実行日で「終了」と誤判定しない）。
 *  - 費用: 1ジョブの上限（残額・1件上限の小さい方）を CallBudget に渡し、実行全体の CallBudget に合算する。出力・原文は記録せず、件数・費用・理由コードだけを返す。
 */
import { absorbBudget, CallBudget } from "@/lib/judgment/call-budget";
import type { Db } from "@/lib/server/lottery-service";
import { evidenceFromLastGood } from "@/lib/collector/evidence";
import { preflightRun } from "@/lib/judgment/xsource/cost-preflight";
import { makeAnthropicRegistrationJudge, makeAnthropicResearchAgent, OUTPUT_MAX_TOKENS, type AiDiagnostic } from "@/lib/judgment/xsource/research-ai";
import { DEFAULT_RESEARCH_LIMITS, type ResearchLimits } from "@/lib/judgment/xsource/research-loop";
import { generateProposalsForCandidate, type CandidateRow } from "@/lib/server/proposals/generate";
import { productionPreviewPermission } from "@/lib/server/proposals/prod-gate";
import { shadowApiKey } from "./allow";
import { issueProductionShadowTicket } from "@/lib/server/proposals/real-gate";

type Env = Record<string, string | undefined>;
type Client = Parameters<typeof makeAnthropicResearchAgent>[0];

/** 他の機能が使うAPIキー（名前に ANTHROPIC と KEY を含む／フォールバックキー。専用キー自身は除く）。値は比較にだけ使い、記録しない。名前を個別に列挙しない（新しい機能のキーも自動で共用検出の対象になる） */
const otherKeyValues = (env: Env): string[] => Object.entries(env).filter(([k, v]) => !!v && k !== "SHADOW_ANTHROPIC_API_KEY" && /(ANTHROPIC.*KEY|FALLBACK_KEY)/.test(k)).map(([, v]) => v as string).filter((v) => v !== env.SHADOW_ANTHROPIC_API_KEY);

/** 調査の上限（本番シャドーは検索・実取得なし。評価で使った値と同じ、小さな上限） */
export const SHADOW_PROPOSAL_LIMITS: ResearchLimits = { ...DEFAULT_RESEARCH_LIMITS, maxTurns: 4, maxFetches: 3, maxElapsedMs: 60_000, maxRevisions: 1, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, maxSearches: 0, searchReserveJpy: 0, maxReads: 8, maxReadChars: 24_000 };

export interface ProposalJobSettings {
  enabled: boolean;
  daily_budget_jpy: number;
  per_case_cap_jpy: number;
}

export type ProposalJobResult =
  | { ok: true; fatal?: "auth_error" | "rate_limited"; status: "accepted" | "partial" | "error"; proposals: number; inserted: number; costJpy: number; stopped: boolean; diagnostics: Record<string, number>; revisions: { rounds: number; verified: number; held: number }; basisAt: string | null; decisions: Record<string, number> }
  | { ok: false; reason: string; fatal?: "auth_error" | "rate_limited" };

const classify = (reason: string): "auth" | "rate" | "other" => (/api_error:(401|403)\b/.test(reason) ? "auth" : /api_error:429\b/.test(reason) ? "rate" : "other");

export async function runShadowProposalJob(a: {
  db: Db;
  householdId: string;
  candidate: CandidateRow;
  settings: ProposalJobSettings;
  /** この日の使用済み額（shadow_spent。永続・再起動や多重実行でも回避されない） */
  spentTodayJpy: number;
  /** この世帯の残り予算（日次・月次の小さい方）。呼び出し側が算出 */
  remainingJpy: number;
  client: Client;
  env?: Env;
  runBudget?: CallBudget;
  now?: () => Date;
}): Promise<ProposalJobResult> {
  const env = a.env ?? process.env;
  // ---- 多重の本番ゲート。専用キーは既存のシャドー専用キー（SHADOW_ANTHROPIC_API_KEY）。予算はDBの shadow_settings（日次）に合わせる
  const k = shadowApiKey(env); // 専用キー、または明示スイッチ（SHADOW_REUSE_EXISTING_KEY=allow）で既存キー。費用の安全はDBの予算が担う
  const decision = productionPreviewPermission({
    env: { ...env, PROPOSAL_DAILY_BUDGET_JPY: String(a.settings.daily_budget_jpy), PROPOSAL_ANTHROPIC_API_KEY: k?.key },
    householdId: a.householdId,
    settings: { enabled: a.settings.enabled, kill: false }, // 停止は環境変数（PROPOSAL_KILL・SHADOW_WORKER_KILL）と enabled=false の両方で効く
    usage: { todayJpy: a.spentTodayJpy },
    otherKeys: k?.source === "dedicated" ? otherKeyValues(env) : [], // 専用キーの場合だけ、他機能のキーとの共用を拒否。既存キーの再利用は明示承認済み
  });
  if (!decision.allowed) return { ok: false, reason: `gate:${decision.reasons[0] ?? "denied"}` };
  const caseCap = Math.min(a.settings.per_case_cap_jpy, 5, a.remainingJpy, a.runBudget ? a.runBudget.remainingJpy : Infinity);
  const t = issueProductionShadowTicket(decision, { model: env.SHADOW_PROPOSAL_MODEL?.trim() || "claude-haiku-5-5", totalCapJpy: caseCap, perCaseCapJpy: caseCap });
  if (!t.ok) return { ok: false, reason: `ticket:${t.reason}` };
  if (a.runBudget && a.runBudget.remainingCalls < 8) return { ok: false, reason: "run_call_limit" };

  // ---- 実行前の最悪費用の検査（通らなければ1回も呼ばない）
  const pf = preflightRun({ model: t.ticket.model, totalJpy: caseCap, perCaseJpy: caseCap, cases: 1, limits: SHADOW_PROPOSAL_LIMITS, maxInputTokens: 24_000, maxOutputTokens: OUTPUT_MAX_TOKENS });
  if (!pf.ok) return { ok: false, reason: "budget" };

  const stored = evidenceFromLastGood(a.candidate.last_good);
  const basisAt = stored?.fetchedAt ?? null; // 収集時刻（評価の基準時刻）
  const diagnostics: Record<string, number> = {};
  const state: { fatal: "auth_error" | "rate_limited" | null } = { fatal: null };
  const onDiagnostic = (d: AiDiagnostic): void => {
    const key = `${d.role}:${d.reason}`.slice(0, 80);
    diagnostics[key] = (diagnostics[key] ?? 0) + 1;
    const c = classify(d.reason);
    if (c === "auth") state.fatal = "auth_error";
    else if (c === "rate") state.fatal = "rate_limited";
  };
  const agent = makeAnthropicResearchAgent(a.client, { model: t.ticket.model, onDiagnostic });
  const judge = makeAnthropicRegistrationJudge(a.client, { model: t.ticket.model, onDiagnostic });
  const budget = new CallBudget({ maxCalls: 24, maxCostJpy: caseCap });
  const clock = basisAt ? new Date(basisAt) : (a.now ?? (() => new Date()))();
  const r = await generateProposalsForCandidate({
    db: a.db,
    householdId: a.householdId,
    candidate: a.candidate,
    env,
    deps: { agent, judge, mode: "real", modelId: t.ticket.model, ticket: t.ticket, budget, perItemCapJpy: Math.min(caseCap, 3), limits: SHADOW_PROPOSAL_LIMITS, now: () => clock, learn: true, shouldStop: () => state.fatal !== null },
  });
  if (a.runBudget) absorbBudget(a.runBudget, budget);
  if (!r.ok) return { ok: false, reason: `generate:${r.reason}`, ...(state.fatal ? { fatal: state.fatal } : {}) };
  const decisions: Record<string, number> = {};
  const rev = { rounds: 0, verified: 0, held: 0 };
  for (const x of r.records) {
    decisions[x.decision] = (decisions[x.decision] ?? 0) + 1;
    const m = /\|rev:(\d+)/.exec(x.stopReason);
    if (m) {
      rev.rounds += Number(m[1]);
      if (x.verified) rev.verified++;
      else rev.held++;
    }
  }
  const failedAll = r.records.length > 0 && r.records.every((x) => x.decision === "none");
  return {
    ok: true,
    status: failedAll ? "error" : r.stopped ? "partial" : "accepted",
    proposals: r.records.length,
    inserted: r.save.inserted,
    costJpy: Math.round(budget.costJpy * 10_000) / 10_000,
    stopped: r.stopped,
    diagnostics,
    revisions: rev,
    basisAt,
    decisions,
    ...(state.fatal ? { fatal: state.fatal } : {}),
  };
}
