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

/**
 * 【履歴】以前の「1候補の調査に使える実時間」45秒（候補の全項目で共有）。AUTONOMY_RESTORATION（V22）で廃止した。
 * まとめ投稿の後ろの項目が調査0回のまま時間切れになり、AIの判断を失わせていた。互換のため値だけ残す（新しい経路では使わない）
 */
export const RESEARCH_WINDOW_MS = 45_000;
/**
 * AUTONOMY_RESTORATION（V22）: 時間の外枠。実行環境の上限（Vercelの関数時間）は1回の実行の外枠であり、調査の締切ではない。
 *  - ITEM_RESEARCH_WINDOW_MS: 1項目の調査の外枠（暴走防止。AIは十分なら早く終える）
 *  - JUDGE_RESERVE_MS: 1回の実行の終わりまでに、判断・自己修正・上位の判断の時間として残す時間
 *  - MIN_ITEM_START_MS: 1回の実行の残りがこれより短ければ、その項目は始めず次の実行へ回す（未完了。保留・除外ではない）
 * 理由: 思考つきの1回の呼び出しは十数〜数十秒（2026-11-27 実測・中央値で1項目60〜90秒）。見直し: 実行の再開の実績（再開の回数・未完了の滞留）で調整する
 */
export const ITEM_RESEARCH_WINDOW_MS = 150_000;
export const JUDGE_RESERVE_MS = 75_000;
export const MIN_ITEM_START_MS = JUDGE_RESERVE_MS + 30_000;

/**
 * 共通の調査上限（評価と本番シャドーで同じ）。AUTONOMY_RESTORATION で、能力を抑えていた回数の上限（ターン4・取得3・検索1・修正1・read 8回/24,000字）を、
 * 暴走を防ぐ外枠（ターン10・取得8・検索4・修正2・read 16回/60,000字・空振り3）に広げた。調査を続けるかはAIが判断し、費用は1候補の上限（予算）が縛る
 */
export function researchLimits(o: { search?: boolean; searchReserveJpy?: number; maxElapsedMs?: number } & Partial<ResearchLimits> = {}): ResearchLimits {
  const { search, searchReserveJpy, maxElapsedMs, ...rest } = o;
  return { ...DEFAULT_RESEARCH_LIMITS, maxTurns: 10, maxFetches: 8, maxElapsedMs: maxElapsedMs ?? 600_000, maxConsecutiveFailuresPerHost: 2, maxNoProgressTurns: 3, maxRevisions: 2, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, maxSearches: search ? 4 : 0, searchReserveJpy: search ? (searchReserveJpy ?? 2.5) : 0, maxReads: 16, maxReadChars: 60_000, ...rest };
}

/**
 * 1回の実行の時間の扱い（項目ごとの締切・次の項目を始めてよいか）。runDeadlineMs（1回の実行を安全に終えるべき時刻）があれば、
 * 判断の時間を残して項目の調査を打ち切り、足りなければ項目を始めない（次の実行で再開）。無ければ（隔離評価）項目ごとの外枠だけ
 */
export function itemTiming(runDeadlineMs: number | undefined, clock: () => number = Date.now): { canStartItem: () => boolean; itemDeadline: () => number } {
  let started = 0;
  return {
    // 1回の実行で最初の項目は、判断の時間さえ残れば始める（どの実行でも必ず前へ進む。再開を空回りさせない）。2件目以降は、調査と判断の両方の時間が残るときだけ
    canStartItem: () => {
      const ok = runDeadlineMs === undefined || runDeadlineMs - clock() >= (started === 0 ? JUDGE_RESERVE_MS + 15_000 : MIN_ITEM_START_MS);
      if (ok) started++;
      return ok;
    },
    itemDeadline: () => (runDeadlineMs === undefined ? clock() + ITEM_RESEARCH_WINDOW_MS : Math.min(clock() + ITEM_RESEARCH_WINDOW_MS, runDeadlineMs - JUDGE_RESERVE_MS)),
  };
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
  escalation?: { judge: RegistrationJudge; model: string; primaryModel?: string; auditRate?: number; /** 上位の判断の条件を広げる（隔離評価のみ） */ broad?: boolean; /** 上位の調査AI（AUTONOMY_RESTORATION: 上位も追加の調査をする） */ agent?: ResearchAgent };
  /** 記録するモデルの識別（調査と判断で別のモデルを使うときは両方）。省略時は許可証のモデル */
  modelId?: string;
  /** 【履歴】候補全体の調査の締切。新しい経路では使わない（runDeadlineMs と項目ごとの外枠に置き換え） */
  researchDeadlineMs?: number;
  /** 1回の実行を安全に終えるべき時刻（本番の関数の時間枠）。無ければ（隔離評価）項目ごとの外枠だけ */
  runDeadlineMs?: number;
  /** 以前の実行で完了した項目（再開） */
  skipItems?: ReadonlySet<number>;
  /** 同一性の判断（JUDGMENT_IDENTITY_EFFICIENCY §2）。登録済みの抽選・他の候補との照合。無ければ照合しない */
  identity?: GenerateDeps["identity"];
}): GenerateDeps {
  const timing = itemTiming(a.runDeadlineMs);
  return {
    agent: a.agent,
    judge: a.judge,
    mode: "real",
    modelId: a.modelId ?? a.ticket.model,
    ...(a.escalation ? { escalation: a.escalation } : {}),
    ...(a.researchDeadlineMs !== undefined && a.runDeadlineMs === undefined ? { researchDeadlineMs: a.researchDeadlineMs } : {}),
    canStartItem: timing.canStartItem,
    itemDeadline: timing.itemDeadline,
    ...(a.skipItems?.size ? { skipItems: a.skipItems } : {}),
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
    ...(a.identity ? { identity: a.identity } : {}),
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
