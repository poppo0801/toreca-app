/**
 * 登録案の調査・判断の「共通の組み立て」（Phase 3 RUNTIME_PARITY）。
 * 評価入口（real-run.ts）と本番シャドー（shadow/proposal-job.ts）は、**同じ調査上限・同じ道具の渡し方・同じ生成経路（generateProposalsForCandidate）**を、この部品から作る。
 * 環境ごとの差は次に限る（能力を黙って落とさない）:
 *  - 外部サービスのアダプタ: 実取得は開発＝開発許可の取得／本番＝本番許可（印つき）の取得。AIクライアントは注入。
 *  - 運用の境界: 許可証・承認・予算・保存先・1実行の経過時間（Vercelの制限に合わせる）。
 *  - 提示できない道具は、理由を明示して記録する（toolReport）。「提示されなかった」を「到達不能」と混同しない。
 */
import type { CallBudget } from "@/lib/judgment/call-budget";
import { DEFAULT_RESEARCH_LIMITS, type FetchOutcome, type RegistrationJudge, type ResearchAgent, type ResearchLimits, type ResearchTools } from "@/lib/judgment/xsource/research-loop";
import type { VisionClient } from "@/lib/judgment/xsource/image-evidence";
import { evidenceFromLastGood } from "@/lib/collector/evidence";
import type { RealRunTicket } from "./real-gate";
import type { GenerateDeps } from "./generate";

/** 1候補の調査に使える実時間（ミリ秒）。評価入口と本番で同じ（F1）。残りを判断・自己修正に残し、本番の関数の実行上限（120秒）とワーカーの時間枠（100秒・開始は残り75秒以上）を越えない */
export const RESEARCH_WINDOW_MS = 45_000;

/** 共通の調査上限。評価（real-run）と本番シャドーで同じ値。違うのは search の有無・1実行の経過時間（運用の境界）だけ */
export function researchLimits(o: { search?: boolean; searchReserveJpy?: number; maxElapsedMs?: number } & Partial<ResearchLimits> = {}): ResearchLimits {
  const { search, searchReserveJpy, maxElapsedMs, ...rest } = o;
  return { ...DEFAULT_RESEARCH_LIMITS, maxTurns: 4, maxFetches: 3, maxElapsedMs: maxElapsedMs ?? 180_000, maxConsecutiveFailuresPerHost: 2, maxNoProgressTurns: 2, maxRevisions: 1, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, maxSearches: search ? 1 : 0, searchReserveJpy: search ? (searchReserveJpy ?? 2.5) : 0, maxReads: 8, maxReadChars: 24_000, ...rest };
}

export interface PipelineTools {
  liveFetch?: (url: string) => Promise<FetchOutcome>;
  search?: ResearchTools["search"];
  vision?: VisionClient;
}

/** 道具の提示状況（記録用。URL・秘密を含めない）。提示しない道具は理由を持つ */
export type ToolReport = { liveFetch: "offered" | string; search: "offered" | string; vision: "offered" | string; stored: "offered" };

/** 調査・判断の依存を、評価入口と本番シャドーで同じ形に組み立てる */
export function assembleGenerateDeps(a: {
  agent: ResearchAgent;
  judge: RegistrationJudge;
  ticket: RealRunTicket;
  budget: CallBudget;
  limits: ResearchLimits;
  perItemCapJpy: number;
  tools: PipelineTools;
  now?: () => Date;
  shouldStop?: () => boolean;
  learn?: boolean;
  /** 記録するモデルの識別（調査と判断で別のモデルを使うときは両方）。省略時は許可証のモデル */
  modelId?: string;
  researchDeadlineMs?: number;
}): GenerateDeps {
  return {
    agent: a.agent,
    judge: a.judge,
    mode: "real",
    modelId: a.modelId ?? a.ticket.model,
    ...(a.researchDeadlineMs !== undefined ? { researchDeadlineMs: a.researchDeadlineMs } : {}),
    ticket: a.ticket,
    budget: a.budget,
    perItemCapJpy: a.perItemCapJpy,
    limits: a.limits,
    ...(a.tools.search ? { search: a.tools.search } : {}),
    ...(a.tools.liveFetch ? { liveFetch: a.tools.liveFetch } : {}),
    ...(a.tools.vision ? { vision: a.tools.vision } : {}),
    ...(a.learn !== undefined ? { learn: a.learn } : {}),
    ...(a.now ? { now: a.now } : {}),
    ...(a.shouldStop ? { shouldStop: a.shouldStop } : {}),
  };
}

/** 道具の提示状況。提示しない理由を明示する（unavailable:理由）。共通経路の保存済みデータ（stored）は常に提示 */
export function toolReport(tools: PipelineTools, why: { liveFetch?: string; search?: string; vision?: string } = {}): ToolReport {
  return {
    stored: "offered",
    liveFetch: tools.liveFetch ? "offered" : `unavailable:${why.liveFetch ?? "not_configured"}`,
    search: tools.search ? "offered" : `unavailable:${why.search ?? "not_configured"}`,
    vision: tools.vision ? "offered" : `unavailable:${why.vision ?? "not_configured"}`,
  };
}

/**
 * 評価の基準時刻。保存された収集時刻（evidence.fetchedAt）に固定する。実行が遅れても、収集時点と同じ時刻の基準で締切・終了を判断する（実行日で「終了」と誤判定しない）。
 * 評価入口と本番シャドーで同じ規則。収集時刻が無い候補だけ、fallback（既定: 現在時刻）。**現在の応募状態は、実取得したページの内容（取得時刻つき）で別に確認する**（基準時刻と区別）。
 */
export function basisClock(candidate: { last_good?: unknown }, fallback: () => Date = () => new Date()): () => Date {
  const at = evidenceFromLastGood(candidate.last_good)?.fetchedAt;
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? () => d : fallback;
}
