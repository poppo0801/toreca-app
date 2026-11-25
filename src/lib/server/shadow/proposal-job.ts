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
import { MODEL_PRICES } from "@/lib/ai-cost";
import { preflightRun, worstCaseCallJpy } from "@/lib/judgment/xsource/cost-preflight";
import { makeAnthropicRegistrationJudge, makeAnthropicResearchAgent, OUTPUT_MAX_TOKENS, type AiDiagnostic } from "@/lib/judgment/xsource/research-ai";
import type { ResearchLimits } from "@/lib/judgment/xsource/research-loop";
import { prefetchSourcePage } from "@/lib/server/proposals/source-prefetch";
import { makeSearchTool, type SearchProviderLike } from "@/lib/judgment/xsource/research-search";
import { makeShadowLivePublicFetch, shadowLiveFetchAllowed, type LiveRecord } from "@/lib/judgment/xsource/live-fetch";
import { makeRealVisionClient, worstCaseVisionCallJpy } from "@/lib/judgment/xsource/vision-real";
import { markShadowTool } from "@/lib/judgment/xsource/shadow-tool-mark";
import { fetchPublicImage } from "@/lib/server/images/image-fetch";
import { splitPublicImage } from "@/lib/server/images/split-adapter";
import { assembleGenerateDeps, basisClock, researchLimits, toolReport, type PipelineTools, type ToolReport } from "@/lib/server/proposals/pipeline";
import { generateProposalsForCandidate, type CandidateRow } from "@/lib/server/proposals/generate";
import { productionPreviewPermission } from "@/lib/server/proposals/prod-gate";
import { shadowApiKey } from "./allow";
import { issueProductionShadowTicket } from "@/lib/server/proposals/real-gate";

type Env = Record<string, string | undefined>;
type Client = Parameters<typeof makeAnthropicResearchAgent>[0];

/** 他の機能が使うAPIキー（名前に ANTHROPIC と KEY を含む／フォールバックキー。専用キー自身は除く）。値は比較にだけ使い、記録しない。名前を個別に列挙しない（新しい機能のキーも自動で共用検出の対象になる） */
const otherKeyValues = (env: Env): string[] => Object.entries(env).filter(([k, v]) => !!v && k !== "SHADOW_ANTHROPIC_API_KEY" && /(ANTHROPIC.*KEY|FALLBACK_KEY)/.test(k)).map(([, v]) => v as string).filter((v) => v !== env.SHADOW_ANTHROPIC_API_KEY);

/** 調査の上限。評価入口（real-run）と同じ共通値（pipeline.ts）。違いは1実行の経過時間（Vercelの制限に合わせて60秒）と、検索を渡さないこと（1件¥3の枠に検索の予約が収まらない）だけ */
/** 検索を渡すときの最悪費用（円）: 検索1回 ≒ ¥1.5（1,000回$10）＋結果を読むトークン。1件の上限（¥10）に収まるときだけ検索を渡す */
export const SHADOW_SEARCH_WORST_JPY = 3.7;
/** 判断の呼び出し1回の予約（円）。調査用の既定（¥0.6）か、判断モデルの実測に近い想定（入力9,000・出力1,500トークン）の大きい方 */
export const judgeReserveFor = (model: string): number => Math.max(0.6, Math.round(worstCaseCallJpy(model, 9_000, 1_500) * 100) / 100);
export const shadowProposalLimits = (search: boolean, judgeModel?: string): ResearchLimits => researchLimits({ maxElapsedMs: 60_000, search, searchReserveJpy: SHADOW_SEARCH_WORST_JPY, ...(judgeModel ? { judgeReserveJpy: judgeReserveFor(judgeModel) } : {}) });
export const SHADOW_PROPOSAL_LIMITS: ResearchLimits = shadowProposalLimits(false);


export interface ProposalJobSettings {
  enabled: boolean;
  daily_budget_jpy: number;
  per_case_cap_jpy: number;
  /** 登録判断だけのモデル（DBの設定。NULL=調査と同じ）。料金が分かるモデルだけ採用する */
  judge_model?: string | null;
}

/** 実行の痕跡（件数・ホスト名・理由コードだけ。URL全体・原文・秘密を含めない） */
export interface ProposalTrace {
  tools: ToolReport;
  /** 実取得の試行（ホスト・結果の種類）。取得失敗・robots・ログイン必須などを「調査不能」とひとまとめにしない */
  fetches: { host: string; outcome: string }[];
  /** 項目ごとの調査の終了理由・取得元URLの状態・読んだページ数・ターン数 */
  endReasons: Record<string, number>;
  urlStatuses: Record<string, number>;
  pages: number;
  turns: number;
  images?: Record<string, number>;
  /** 取得元ページの事前取得（none=取得元なし／saved_recent=24時間以内に保存済み／stored=今回保存／failed:理由）。AIの費用は掛からない */
  prefetch?: string;
}

export type ProposalJobResult =
  | { ok: true; fatal?: "auth_error" | "rate_limited"; status: "accepted" | "partial" | "error"; proposals: number; inserted: number; costJpy: number; stopped: boolean; diagnostics: Record<string, number>; revisions: { rounds: number; verified: number; held: number }; basisAt: string | null; decisions: Record<string, number>; trace: ProposalTrace }
  | { ok: false; reason: string; fatal?: "auth_error" | "rate_limited"; /** 失敗でも、すでにかかった費用（円）。記録して予算から差し引く */ costJpy?: number; trace?: ProposalTrace };

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
  /** 検索の部品（本番の入口が渡す）。評価入口と同じ makeSearchTool を通し、本番の許可の印をつけて渡す。実取得が許可されているときだけ使う */
  searchProvider?: SearchProviderLike;
  /** テスト用: 取得の下位部品（safe-fetch）の差し替え。外部アクセスをモックしても、本番と同じ入口・許可・道具の契約を通る */
  fetchHooks?: Pick<NonNullable<Parameters<typeof makeShadowLivePublicFetch>[0]>, "fetchImpl" | "sleep" | "now">;
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
  const judgeModel = a.settings.judge_model && MODEL_PRICES[a.settings.judge_model] ? a.settings.judge_model : null; // 料金が分からないモデルは採用しない（費用を保証できない）
  const caseCap = Math.min(a.settings.per_case_cap_jpy, 10, a.remainingJpy, a.runBudget ? a.runBudget.remainingJpy : Infinity);
  const t = issueProductionShadowTicket(decision, { model: env.SHADOW_PROPOSAL_MODEL?.trim() || "claude-haiku-5-5", totalCapJpy: caseCap, perCaseCapJpy: caseCap });
  if (!t.ok) return { ok: false, reason: `ticket:${t.reason}` };
  if (a.runBudget && a.runBudget.remainingCalls < 8) return { ok: false, reason: "run_call_limit" };

  // ---- 道具（共通経路 pipeline.ts と同じ契約）。実取得・画像は本番の許可を通した印つきのものだけ。検索は予算の都合で渡さない（理由を明示して記録）
  const stored = evidenceFromLastGood(a.candidate.last_good);
  const tools: PipelineTools = {};
  const why: { liveFetch?: string; search?: string; vision?: string } = { search: a.searchProvider ? undefined : "no_provider" };
  let fetchLog: LiveRecord[] = [];
  const lfAllowed = shadowLiveFetchAllowed(env);
  if (lfAllowed.ok) {
    const lf = makeShadowLivePublicFetch({ env, maxFetches: SHADOW_PROPOSAL_LIMITS.maxFetches, minIntervalMs: 1000, ...(a.fetchHooks ?? {}) });
    tools.liveFetch = lf.fetchPage;
    fetchLog = lf.log;
  } else why.liveFetch = "not_permitted";
  // 検索（評価入口と同じ makeSearchTool）。実取得が許可され、最悪費用が1件上限に収まるときだけ。収まらなければ理由つきで渡さない（無断で上限を超えない）
  let useSearch = !!a.searchProvider && lfAllowed.ok;
  if (a.searchProvider && !lfAllowed.ok) why.search = "live_fetch_not_permitted";
  if (useSearch) {
    const spf = preflightRun({ model: judgeModel ?? t.ticket.model, totalJpy: caseCap, perCaseJpy: caseCap, cases: 1, limits: shadowProposalLimits(true, judgeModel ?? undefined), maxInputTokens: 24_000, maxOutputTokens: OUTPUT_MAX_TOKENS, searchWorstJpy: SHADOW_SEARCH_WORST_JPY });
    if (!spf.ok) {
      useSearch = false;
      why.search = "budget_per_case";
    }
  }
  if (useSearch && a.searchProvider) tools.search = markShadowTool(makeSearchTool(a.searchProvider));
  const limits = shadowProposalLimits(useSearch, judgeModel ?? undefined);

  // ---- 実行前の最悪費用の検査（通らなければ1回も呼ばない）。画像解析を渡すときは、その最悪費用も予約に含める
  const imageWorst = worstCaseVisionCallJpy(t.ticket.model, [{ width: 1200, height: 1600 }]);
  const wantVision = (stored?.imageRefs?.length ?? 0) > 0;
  const pfOf = (withImage: boolean) => preflightRun({ model: judgeModel ?? t.ticket.model, totalJpy: caseCap, perCaseJpy: caseCap, cases: 1, limits, maxInputTokens: 24_000, maxOutputTokens: OUTPUT_MAX_TOKENS, ...(withImage ? { images: { perCaseCount: 1, worstJpyEach: imageWorst } } : {}) });
  let useVision = wantVision;
  let pf = pfOf(useVision);
  if (useVision && (!pf.ok || pf.warnings.some((w) => w.startsWith("per_case_cannot_afford_image")))) {
    useVision = false; // 画像の最悪費用が1件上限に収まらない: 画像は解析せず、理由を記録（無断で上限を超えない）
    why.vision = "budget_per_case";
    pf = pfOf(false);
  }
  if (!pf.ok) return { ok: false, reason: "budget" };
  if (!wantVision) why.vision = "no_images";

  // 取得元ページの事前取得・保存（AIの費用なし・現行の収集とは独立）。保存した全文は、調査（generate の fetchPage）が最優先で読む。失敗しても調査は続く
  let prefetch = "not_permitted";
  if (lfAllowed.ok) {
    const pre = makeShadowLivePublicFetch({ env, maxFetches: 1, minIntervalMs: 1000, ...(a.fetchHooks ?? {}) });
    prefetch = (await prefetchSourcePage({ db: a.db, householdId: a.householdId, candidate: a.candidate, fetchPage: pre.fetchPage, ...(a.now ? { now: a.now } : {}) })).status;
  }
  const diagnostics: Record<string, number> = {};
  const state: { fatal: "auth_error" | "rate_limited" | null } = { fatal: null };
  const onDiagnostic = (d: AiDiagnostic): void => {
    const key = `${d.role}:${d.reason}`.slice(0, 80);
    diagnostics[key] = (diagnostics[key] ?? 0) + 1;
    const c = classify(d.reason);
    if (c === "auth") state.fatal = "auth_error";
    else if (c === "rate") state.fatal = "rate_limited";
  };
  const basisAt = stored?.fetchedAt ?? null; // 収集時刻（評価の基準時刻）
  const agent = makeAnthropicResearchAgent(a.client, { model: t.ticket.model, onDiagnostic });
  const judge = makeAnthropicRegistrationJudge(a.client, { model: judgeModel ?? t.ticket.model, onDiagnostic });
  const budget = new CallBudget({ maxCalls: 24, maxCostJpy: caseCap });
  if (useVision) {
    // 画像解析も同じ予算（budget）を共有する。1件あたり最大1枚。取得は既存の安全な画像取得（SSRF・サイズ・時間の検査）
    const v = makeRealVisionClient({ client: a.client as never, ticket: t.ticket, budget, fetchImage: (u) => fetchPublicImage(u), splitImage: splitPublicImage, model: t.ticket.model, maxImages: 1 });
    tools.vision = markShadowTool(v.vision);
  }
  const clock = basisClock(a.candidate, a.now ?? (() => new Date())); // 収集時刻（評価入口と同じ共通規則）
  const r = await generateProposalsForCandidate({
    db: a.db,
    householdId: a.householdId,
    candidate: a.candidate,
    env,
    deps: assembleGenerateDeps({ agent, judge, ticket: t.ticket, budget, limits, perItemCapJpy: caseCap, tools, ...(judgeModel && judgeModel !== t.ticket.model ? { modelId: `${t.ticket.model}+judge:${judgeModel}` } : {}), now: clock, learn: true, shouldStop: () => state.fatal !== null }),
  });
  if (a.runBudget) absorbBudget(a.runBudget, budget);
  const spent = Math.round(budget.costJpy * 10_000) / 10_000;
  const bump = (m: Record<string, number>, k: string): void => {
    m[k] = (m[k] ?? 0) + 1;
  };
  const trace: ProposalTrace = { tools: toolReport(tools, why), fetches: fetchLog.slice(0, 12).map((x) => ({ host: x.host, outcome: x.outcome })), endReasons: {}, urlStatuses: {}, pages: 0, turns: 0, prefetch };
  if (!r.ok) return { ok: false, reason: `generate:${r.reason}`, costJpy: spent, trace, ...(state.fatal ? { fatal: state.fatal } : {}) };
  const decisions: Record<string, number> = {};
  const rev = { rounds: 0, verified: 0, held: 0 };
  for (const x of r.records) {
    decisions[x.decision] = (decisions[x.decision] ?? 0) + 1;
    bump(trace.endReasons, x.endReason ?? "?");
    bump(trace.urlStatuses, x.urlStatus);
    trace.pages += x.pages.length;
    trace.turns += x.turns;
    const m = /|rev:(d+)/.exec(x.stopReason);
    if (m) {
      rev.rounds += Number(m[1]);
      if (x.verified) rev.verified++;
      else rev.held++;
    }
  }
  if (r.storage.images) trace.images = { ...r.storage.images } as unknown as Record<string, number>;
  const failedAll = r.records.length > 0 && r.records.every((x) => x.decision === "none");
  return {
    ok: true,
    status: failedAll ? "error" : r.stopped ? "partial" : "accepted",
    proposals: r.records.length,
    inserted: r.save.inserted,
    costJpy: spent,
    stopped: r.stopped,
    diagnostics,
    revisions: rev,
    basisAt,
    decisions,
    trace,
    ...(state.fatal ? { fatal: state.fatal } : {}),
  };
}
