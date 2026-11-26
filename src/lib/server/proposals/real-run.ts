/**
 * 実AIによる「収集候補 → 調査・判断 → 登録案の保存」の評価入口（Phase 2・開発専用）。**この入口は、承認済みの関門を通った評価（scripts/proposal-real.mjs → proposal-real.real.test.ts）だけが呼ぶ**。
 *  - 一般の画面・server action・cron・収集の接続口は、このモジュールを import しない（静的テスト）。実AIのクライアントはここでは作らず、**呼び出し側が注入**する（テストは台本のクライアント・費用0）。
 *  - 許可証（real-gate.ts）: 関門（承認額・確認・開発専用キー・開発環境）＋ローカルのSupabase でなければ発行しない。本番の候補・本番DBに対して実AIを実行しない。
 *  - 費用: 実行前に `preflightRun`（総額・1件・調査/判断/検索の予約・関門の上限・最悪費用）を検査し、通らなければ1回も呼ばない。全体は `CallBudget`、1件は `CaseBudget`（予約→実費の計上。実費超過は記録し、残りが無ければ次を呼ばない）。
 *    **API側の請求額を保証するものではない**（予約が最悪費用以上の設定でのみ「1回の呼び出しで予約を超えない」。検索は maxMessages で最悪値を抑える）。
 *  - 停止条件（無限再試行・二重起動・請求失敗の防止）: 認証/権限エラー（401/403）・利用上限（429）は**即停止**（再試行しない）／通信・5xx・出力不備が連続3候補で停止／予算が尽きたら停止／協調的な中止／二重起動はロックで拒否。maxRetries=0（呼び出し側のクライアント設定）。
 *  - 監査ログ（onEvent）: 候補は短いハッシュ・件数・費用・理由コードだけ。**原文・URL・キー・投稿全文を含めない**。失敗は握りつぶさず分類して記録する。
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { CallBudget } from "@/lib/judgment/call-budget";
import { CANDIDATE_CAP_PER_CASE_JPY, type JudgmentRealGate } from "@/lib/judgment/real-gate";
import { preflightRun, type PreflightResult } from "@/lib/judgment/xsource/cost-preflight";
import { makeAnthropicRegistrationJudge, makeAnthropicResearchAgent, OUTPUT_MAX_TOKENS, type AiDiagnostic } from "@/lib/judgment/xsource/research-ai";
import type { FetchOutcome, ResearchLimits } from "@/lib/judgment/xsource/research-loop";
import type { VisionClient } from "@/lib/judgment/xsource/image-evidence";
import { worstCaseVisionCallJpy } from "@/lib/judgment/xsource/vision-real";
import { makeSearchTool, type SearchProviderLike } from "@/lib/judgment/xsource/research-search";
import type { Db } from "@/lib/server/lottery-service";
import { generateProposalsForCandidate, type CandidateRow } from "./generate";
import { prefetchSourcePage } from "./source-prefetch";
import { issueRealRunTicket, type RealRunTicket } from "./real-gate";
import { assembleGenerateDeps, basisClock, researchLimits, RESEARCH_WINDOW_MS } from "./pipeline";

type Client = Parameters<typeof makeAnthropicResearchAgent>[0];

export type RunEvent =
  | { kind: "run_start"; candidates: number; model: string; totalCapJpy: number; perCaseCapJpy: number; search: boolean; liveFetch: boolean }
  | { kind: "preflight"; ok: boolean; errors: string[]; warnings: string[]; minPerCaseJpy: number; maxReservedPerCaseJpy: number; reservationCoversWorstCase: boolean }
  | { kind: "candidate_done"; candidate: string; proposals: number; inserted: number; costJpy: number; stopped: boolean; diagnostics: number }
  | { kind: "candidate_failed"; candidate: string; reason: string }
  | { kind: "run_stop"; reason: StopReason; processed: number; costJpy: number };

export type StopReason = "completed" | "cancelled" | "auth_error" | "rate_limited" | "consecutive_failures" | "budget_exhausted" | "preflight_failed" | "locked" | "not_permitted" | "persist_failed";

export interface RealRunSummary {
  stopReason: StopReason;
  candidates: number;
  processed: number;
  proposals: number;
  inserted: number;
  costJpy: number;
  overruns: number;
  preflight: PreflightResult | null;
  /** 失敗の分類ごとの件数（内容を含めない） */
  diagnostics: Record<string, number>;
  /** 判断の内訳（項目単位）: ok=判断あり／defaulted=項目が省略された出力（主張なし。成功と数えない）／failed=判断が得られなかった */
  judgments: { ok: number; defaulted: number; failed: number };
  /** 取得した全文・取得網羅性の計測の保存（失敗は握り潰さず件数で残す。登録案の保存とは独立） */
  storage: { documents: { saved: number; existing: number; failed: number }; stats: { saved: number; failed: number } };
  /** 検索の提示と実行（項目単位）: 提示されなかった項目・提示されたが実行しなかった項目・実行した項目。P2 の「検索0回」を、配線の不備と区別して観測する */
  search: { notOffered: number; offeredNotUsed: number; used: number };
  rows: { candidate: string; status: "done" | "failed" | "skipped"; proposals: number; costJpy: number; reason?: string }[];
}

export interface RealRunOptions {
  db: Db;
  householdId: string;
  candidates: CandidateRow[];
  /** 注入するAIクライアント（本番キーで作ったものを渡さない。テストは台本の費用0のクライアント） */
  client: Client;
  gate: JudgmentRealGate;
  env?: Record<string, string | undefined>;
  /** 検索（読み取り専用）。渡したときだけ検索を使う。worstJpy は検索1回の最悪費用（円。予約の検査に使う） */
  search?: { provider: SearchProviderLike; worstJpy: number; reserveJpy?: number };
  liveFetch?: (url: string) => Promise<FetchOutcome>;
  /** 画像の実解析（vision-real の makeRealVisionClient が返す）。同じ予算（budget）を共有する。渡さなければ画像は解析しない（読み取り済みの再利用だけ） */
  vision?: VisionClient;
  /** 実行の予算・許可証が出来てから画像解析のクライアントを作る（同じ予算を共有させるため）。halted は認証・利用上限で停止中かを返す */
  visionFactory?: (ctx: { ticket: RealRunTicket; budget: CallBudget }) => { vision: VisionClient; halted?: () => string | null };
  /** 候補ごとの設定の差（比較試験のアーム: 経験ヒントの有無・画像解析の有無）。許可証・予算・モード・AIは上書きできない */
  depsFor?: (c: CandidateRow) => { learn?: boolean; vision?: boolean };
  /** 1候補あたりに解析する画像の最大枚数（preflight の予約に含める） */
  maxImagesPerCase?: number;
  limits?: Partial<ResearchLimits>;
  maxConsecutiveFailures?: number;
  shouldStop?: () => boolean;
  onEvent?: (e: RunEvent) => void;
  /**
   * 候補1件の処理が終わるたびに（実行の終了を待たず）呼ばれ、結果を耐障害的に保存する。完了を待つ。
   * 保存に失敗したら、以降の有料呼び出しを止める（保存できない結果に費用をかけ続けない。stopReason=persist_failed）。
   */
  afterCandidate?: (a: { candidate: CandidateRow; ok: boolean; costJpy: number; reason?: string }) => Promise<void>;
  lockPath?: string;
  now?: () => Date;
}

const short = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 8);

/** 二重起動の防止（ロックファイル）。古いロック（3時間超）は無効とみなす。取得できなければ null */
export function acquireRunLock(path: string, maxAgeMs = 3 * 3600_000): (() => void) | null {
  try {
    if (existsSync(path) && Date.now() - statSync(path).mtimeMs > maxAgeMs) unlinkSync(path);
    const fd = openSync(path, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    closeSync(fd);
    return () => {
      try {
        if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).pid === process.pid) unlinkSync(path);
      } catch {
        /* 解放の失敗は無視（次回は古いロックとして扱われる） */
      }
    };
  } catch {
    return null;
  }
}

const classify = (reason: string): "auth" | "rate" | "transient" => (/api_error:(401|403)\b/.test(reason) ? "auth" : /api_error:429\b/.test(reason) ? "rate" : "transient");

export async function runRealProposals(o: RealRunOptions): Promise<RealRunSummary> {
  const env = o.env ?? process.env;
  const emit = (e: RunEvent) => {
    try {
      o.onEvent?.(e);
    } catch {
      /* 監査ログの失敗で実行を壊さない（ただし握りつぶすのは記録側の失敗だけ） */
    }
  };
  const base: RealRunSummary = { stopReason: "completed", candidates: o.candidates.length, processed: 0, proposals: 0, inserted: 0, costJpy: 0, overruns: 0, preflight: null, diagnostics: {}, judgments: { ok: 0, defaulted: 0, failed: 0 }, search: { notOffered: 0, offeredNotUsed: 0, used: 0 }, storage: { documents: { saved: 0, existing: 0, failed: 0 }, stats: { saved: 0, failed: 0 } }, rows: [] };
  const stop = (reason: StopReason): RealRunSummary => {
    emit({ kind: "run_stop", reason, processed: base.processed, costJpy: base.costJpy });
    return { ...base, stopReason: reason };
  };

  const t = issueRealRunTicket(o.gate, env);
  if (!t.ok) {
    base.diagnostics[`ticket:${t.reason}`] = 1;
    return stop("not_permitted");
  }
  const ticket = t.ticket;
  const releaseLock = o.lockPath ? acquireRunLock(o.lockPath) : () => undefined;
  if (!releaseLock) return stop("locked");
  try {
    const limits: ResearchLimits = researchLimits({ search: !!o.search, ...(o.search?.reserveJpy !== undefined ? { searchReserveJpy: o.search.reserveJpy } : {}), ...o.limits }); // 本番シャドーと共通の調査上限（pipeline.ts）
    const pf = preflightRun({ model: ticket.model, totalJpy: ticket.totalCapJpy, perCaseJpy: ticket.perCaseCapJpy, cases: o.candidates.length, limits, maxInputTokens: 24_000, maxOutputTokens: OUTPUT_MAX_TOKENS, ...(o.search ? { searchWorstJpy: o.search.worstJpy } : {}), ...(o.vision || o.visionFactory ? { images: { perCaseCount: o.maxImagesPerCase ?? 4, worstJpyEach: worstCaseVisionCallJpy(ticket.model, [{ width: 1200, height: 1600 }]) } } : {}), gatePerCaseCapJpy: CANDIDATE_CAP_PER_CASE_JPY });
    base.preflight = pf;
    emit({ kind: "preflight", ok: pf.ok, errors: pf.errors, warnings: pf.warnings, minPerCaseJpy: pf.minPerCaseJpy, maxReservedPerCaseJpy: pf.maxReservedPerCaseJpy, reservationCoversWorstCase: pf.reservationCoversWorstCase });
    if (!pf.ok) return stop("preflight_failed"); // 1回もAIを呼ばない
    emit({ kind: "run_start", candidates: o.candidates.length, model: ticket.model, totalCapJpy: ticket.totalCapJpy, perCaseCapJpy: ticket.perCaseCapJpy, search: !!o.search, liveFetch: !!o.liveFetch });

    const budget = new CallBudget({ maxCalls: Math.max(20, o.candidates.length * 30), maxCostJpy: ticket.totalCapJpy });
    let fatal: StopReason | null = null;
    let consecutive = 0;
    let diagsThisCandidate = 0;
    const onDiagnostic = (d: AiDiagnostic) => {
      const key = `${d.role}:${d.reason}`;
      base.diagnostics[key] = (base.diagnostics[key] ?? 0) + 1;
      diagsThisCandidate++;
      const c = classify(d.reason);
      if (c === "auth") fatal = "auth_error"; // 認証・権限エラーは再試行しない
      else if (c === "rate") fatal = "rate_limited"; // 利用上限に当たったら、叩き続けない
    };
    const agent = makeAnthropicResearchAgent(o.client, { model: ticket.model, onDiagnostic });
    const judge = makeAnthropicRegistrationJudge(o.client, { model: ticket.model, onDiagnostic });
    const searchTool = o.search ? makeSearchTool(o.search.provider) : undefined;
    const visionHandle = o.visionFactory ? o.visionFactory({ ticket, budget }) : o.vision ? { vision: o.vision } : undefined;
    const maxConsecutive = o.maxConsecutiveFailures ?? 3;

    for (const c of o.candidates) {
      if (o.shouldStop?.()) return finish("cancelled");
      if (fatal) return finish(fatal);
      if (budget.remainingJpy < limits.agentReserveJpy + limits.judgeReserveJpy) return finish("budget_exhausted");
      diagsThisCandidate = 0;
      if (o.liveFetch) await prefetchSourcePage({ db: o.db, householdId: o.householdId, candidate: c, fetchPage: o.liveFetch, ...(o.now ? { now: o.now } : {}) }); // 本番シャドーと同じ事前取得・保存（共通の前処理）
      const r = await generateProposalsForCandidate({
        db: o.db,
        householdId: o.householdId,
        candidate: c,
        env,
        deps: (() => {
          const dd = o.depsFor?.(c);
          // 共通の組み立て（pipeline.ts）。本番シャドーと同じ形の依存を作る
          return assembleGenerateDeps({ agent, judge, ticket, budget, limits, researchDeadlineMs: Date.now() + RESEARCH_WINDOW_MS, perItemCapJpy: ticket.perCaseCapJpy, tools: { ...(searchTool ? { search: searchTool } : {}), ...(o.liveFetch ? { liveFetch: o.liveFetch } : {}), ...(visionHandle && dd?.vision !== false ? { vision: visionHandle.vision } : {}) }, ...(dd?.learn !== undefined ? { learn: dd.learn } : {}), now: o.now ?? basisClock(c, () => new Date()), shouldStop: () => !!fatal || !!o.shouldStop?.() });
        })(),
      });
      base.processed++;
      const vh = visionHandle?.halted?.();
      if (vh === "auth_error") fatal = "auth_error";
      else if (vh === "rate_limited") fatal = "rate_limited"; // 画像解析の認証・利用上限エラーも、以降を止める
      if (!r.ok) {
        base.rows.push({ candidate: short(c.id), status: "failed", proposals: 0, costJpy: 0, reason: r.reason });
        emit({ kind: "candidate_failed", candidate: short(c.id), reason: r.reason });
        consecutive++;
      } else {
        base.proposals += r.records.length;
        for (const x of r.records) {
          if (x.decision === "none") base.judgments.failed++;
          else if (x.unknowns.some((u) => u.what === "AIの判断" && u.why.includes("省略"))) base.judgments.defaulted++;
          else base.judgments.ok++;
          if (x.stopReason.includes("search_not_offered")) base.search.notOffered++;
          else if (/searched:[1-9]/.test(x.stopReason)) base.search.used++;
          else base.search.offeredNotUsed++;
        }
        base.inserted += r.save.inserted;
        for (const k of ["saved", "existing", "failed"] as const) base.storage.documents[k] += r.storage.documents[k];
        base.storage.stats.saved += r.storage.stats.saved;
        base.storage.stats.failed += r.storage.stats.failed;
        base.costJpy = Math.round(budget.costJpy * 10_000) / 10_000;
        base.rows.push({ candidate: short(c.id), status: "done", proposals: r.records.length, costJpy: r.costJpy });
        emit({ kind: "candidate_done", candidate: short(c.id), proposals: r.records.length, inserted: r.save.inserted, costJpy: r.costJpy, stopped: r.stopped, diagnostics: diagsThisCandidate });
        consecutive = diagsThisCandidate > 0 && r.records.every((x) => x.decision === "none") ? consecutive + 1 : 0;
      }
      base.costJpy = Math.round(budget.costJpy * 10_000) / 10_000;
      if (o.afterCandidate) {
        try {
          await o.afterCandidate({ candidate: c, ok: r.ok, costJpy: r.ok ? r.costJpy : 0, ...(r.ok ? {} : { reason: r.reason }) });
        } catch {
          return finish("persist_failed");
        }
      }
      if (consecutive >= maxConsecutive) return finish("consecutive_failures");
    }
    return finish("completed");

    function finish(reason: StopReason): RealRunSummary {
      base.costJpy = Math.round(budget.costJpy * 10_000) / 10_000;
      base.overruns = budget.overruns.length;
      for (const rest of o.candidates.slice(base.processed)) base.rows.push({ candidate: short(rest.id), status: "skipped", proposals: 0, costJpy: 0 });
      return stop(reason);
    }
  } finally {
    releaseLock();
  }
}
