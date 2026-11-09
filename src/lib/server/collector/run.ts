import "server-only";
import { createHash } from "node:crypto";
import { normalizeConditions, evaluateCandidate, preScreenFromList, type CollectionConditions } from "@/lib/collector/conditions";
import { judgeRelevance, normalizeUrl, parseListHints, parseListing, looksLikeLottery, type AdapterId, type ListHints, type ListingEntry } from "@/lib/collector/listing";
import { remainingPosts, X_COST_PER_POST_JPY, type QuotedPost, type XPost, type XProfile } from "@/lib/collector/x-posts";
import { isReady } from "@/lib/collector/ready";
import { extractPageText } from "@/lib/ai/page-text";
import { PROMPT_VERSION, type LotteryExtractor } from "@/lib/ai/provider";
import { buildDraft, findDuplicates, urlIdentity } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";
import { storeDistance } from "@/lib/store-distance";
import { extractFromRequest, runExtraction, type ExtractResult } from "@/lib/server/lottery-extract-service";
import { estimateCostJpy as estimateAiCostJpy, USD_JPY_ESTIMATE } from "@/lib/ai-cost";
import { monthBudget } from "@/lib/server/ai-budget";
import { loadAppData, saveLottery, type Db } from "@/lib/server/lottery-service";
import { fetchXPost } from "@/lib/server/x-source";
import { fetchRespectingRobots, type SafeFetchResult } from "@/lib/server/safe-fetch";
import { fetchXImage, type XClient } from "@/lib/server/collector/x-client";
import { enrichXPost, makeXRichFetcher } from "@/lib/server/collector/x-rich";
import { MAX_ATTEMPTS as QUEUE_MAX_ATTEMPTS, backoffMs, budgetCallsLeft, reserveEstimateJpy, isoToFlex, jstDayString, priorityScore, detectCancel, diffAgainstLottery, hashNormalized, isNewRound, classifyFailure, FAIL_KIND_LABEL, shouldReanalyzeOnListChange, type FailKind, type FieldChange } from "@/lib/collector/queue";
import { runMemoPass } from "@/lib/server/collector/memos";
import { saveCandidateRows } from "@/lib/server/collector/save-rows";
import { deepClean, safeSlice, safeSliceEnd } from "@/lib/text-safe";
import { emptyFunnel, funnelLine, judgeXPost, type XFunnel } from "@/lib/collector/x-relevance";
import type { ImageStats } from "@/lib/server/collector/x-rich";
import { listInfoFromQueued, rebuildQueued, type AiReason } from "@/lib/collector/queued";
import { dueSources, runResultOf, type AttemptStatus } from "@/lib/collector/schedule";
import { lowInfoOverride, decideHold, hostOf, hostRole, matchExclusion, triagePatch, type ExclusionRule } from "@/lib/collector/triage";
import { activeUserRules, chainAreaSets } from "@/lib/server/collector/user-rules-load";
import type { UserRule } from "@/lib/collector/user-rules";
import { activeExclusions, altPlanFor, recordAltSuccess, recordHardSource } from "@/lib/server/collector/sources-health";
import { loadXIdentities, loadXLinks, saveXIdentity } from "@/lib/server/collector/x-accounts";
import { identifyAccount, identityHint, type AccountIdentity, type SavedIdentity } from "@/lib/collector/store-identity";
import { otherTcgItemIndexes, productNamesOf, tcgTextsOf } from "@/lib/collector/category";
import { PREFECTURE_LIST } from "@/lib/geo";
import { applyAccountHint, normUsername, usernameFromPostUrl, type XLink } from "@/lib/collector/x-accounts";
import { dropUsernameChain, resolveXChain } from "@/lib/collector/x-chain";
import { SELECT_STORE_PLACEHOLDER } from "@/lib/applied-store";
import { detectStoreSelect } from "@/lib/collector/store-select";
import { judgeRegion, isRegionReason, regionExclusionOf } from "@/lib/collector/region";
import { decideRegistration } from "@/lib/collector/attention";
import { classifyReviewReasons } from "@/lib/collector/review-reasons";
import { autoCompleteLottery } from "@/lib/server/collector/complete";
import { classifyStage, hasLotteryWording, STAGE_LABEL } from "@/lib/collector/stage";
import { diffTracking, inheritTracking, type Tracking } from "@/lib/collector/tracking";
import { conditionDiff, conditionDiffText } from "@/lib/collector/condition-diff";
import { assessCompleteness } from "@/lib/collector/completeness";
import { classifySource, conflictLabels, FIELD_LABEL, mergeSides, provenanceFor, type FieldSource, type SourceContext } from "@/lib/collector/fields";
import { isSupplement, matchOpen, matchSupplement, type OpenLite } from "@/lib/collector/supplement";
import { loadOpen, loadSourceCtx } from "@/lib/server/collector/open";
import type { RequirementTag } from "@/lib/lottery-taxonomy";
import { lotteryRow } from "@/lib/lottery-payload";
import type { Json } from "@/types/database";
import type { AppData } from "@/types/domain";

/**
 * 抽選情報の自動収集（Stage 4C）。
 *   収集元 → 告知リンク/X投稿 → 関連判定(ルール) → AI読み取り(既存の共通処理) → 収集条件 → マスター照合 → 重複検出 → 候補/自動登録
 * - 自動収集は要チェックにしない・応募記録を作らない・既存抽選の確定情報を書き換えない（重複時は情報源URLの追加のみ）
 * - 手動実行は利用者のログインで登録。定期実行(service_role)は、service_role専用の登録関数(save_lottery_tx_as)で、条件に一致し情報が十分な抽選だけを自動登録する
 * - AI・X APIは上限(1回あたり/月額予算/既存のAI利用上限)の範囲内でのみ呼ぶ。上限を超える分は次回に回す(キュー)
 */

export const WEB_LIST_MAX_BYTES = 4_500_000;
const MAX_NEW_PER_SOURCE = 60;
/** 新しいXアカウントの初回の取得は、この日数分に絞る（以後は since_id で続きから） */
const X_FIRST_FETCH_DAYS = 14;
/** 1回の収集でこれを超える新規候補が出たら警告する */
const MASS_NEW_WARN = 150;
const STALE_RUN_MS = 15 * 60_000;
const MAX_ATTEMPTS = QUEUE_MAX_ATTEMPTS;
/** AI読み取りを並行して行う件数(60秒の実行時間の中で、より多く解析するため) */
const AI_CONCURRENCY = 4;

export interface CollectDeps {
  db: Db;
  householdId: string;
  trigger: "manual" | "cron";
  now: Date;
  /** 登録先のプロフィール(更新者)。cron では null */
  actor: string | null;
  /** 利用者のログインで実行している（抽選の自動登録ができる） */
  canRegister: boolean;
  /** 定期実行（ログインなし）でも、条件に一致し情報が十分な抽選を自動登録する（service_role専用の登録関数を使う） */
  serviceRegister?: boolean;
  extractor: LotteryExtractor | null;
  fetchList?: (url: string) => Promise<SafeFetchResult>;
  fetchPage?: (url: string) => Promise<SafeFetchResult>;
  fetchOembed?: typeof fetchXPost;
  xClient: XClient | null;
  fetchImage?: typeof fetchXImage;
  budgetMs?: number;
  /** 円換算の為替レート(世帯の設定)。実行の最初に読み込む */
  usdJpy?: number;
  /** 指定した収集元だけ実行する */
  onlySourceIds?: string[];
  /** 定期収集のスロット。指定すると、その収集元だけを取得し、取得結果を定期収集の記録として残す（手動収集の履歴とは独立） */
  scheduled?: { slotDate: string; sourceIds: string[] };
  /** 利用者が登録した公式Xアカウントの対応づけ（解析の開始時に読み込む） */
  xLinks?: Map<string, XLink>;
  /** 確認済みのXアカウントと店舗の対応（自動で読み取ったもの。解析の開始時に読み込む） */
  xIdentities?: Map<string, SavedIdentity>;
  /** 情報源の分類に使う文脈（解析の開始時に読み込む） */
  sourceCtx?: SourceContext;
}

export interface SourceReport {
  sourceId: string;
  name: string;
  status: string;
  message: string;
  items: number;
  newCount: number;
  /** Xの収集元: 各段階で何件が次へ進んだか */
  funnel?: XFunnel;
}

export type CollectOutcome =
  | {
      ok: true;
      runId: string;
      aiCalls: number;
      xCalls: number;
      xPosts: number;
      newCount: number;
      /** 一覧の表示だけで、AI読み取りの前に除外した件数 */
      screened: number;
      /** 解析待ちの残り */
      queued: number;
      registered: number;
      errors: number;
      pending: number;
      sources: SourceReport[];
      notices: string[];
    }
  | { ok: false; code: "already_running" | "error"; message: string };

type SourceRow = {
  id: string;
  kind: "web" | "x";
  name: string;
  url: string | null;
  x_username: string | null;
  x_user_id: string | null;
  adapter: string;
  enabled: boolean;
  interval_hours: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  x_since_id: string | null;
  consecutive_failures: number;
};

interface QueuedPayload {
  queued: {
    kind: "web_page" | "x_oembed" | "x_post";
    url: string;
    title: string;
    context: string;
    /** 一覧の1枚のカード全体の文章（商品名・店舗名・締切・条件）。取得制限のときの二次情報として使う */
    card?: string;
    /** 一覧のカードの構造から読み取れた店舗名・商品名 */
    fields?: { store?: string; product?: string };
    sourceName: string;
    post?: { id: string; text: string; images: string[]; links: string[]; createdAt: string; username?: string; /** 投稿者の固定ID（アカウント名が変わっても同じ店舗として扱うため） */ authorId?: string; profile?: XProfile; quoted?: QuotedPost; replyToId?: string };
    /** 画像の扱い（見つかった／取得できた／AIへ渡した）。解析時に記録する */
    imageStats?: ImageStats;
    /** AI解析へ回した根拠（本文／画像／引用／リンク） */
    relevanceBasis?: string;
    /** 利用者のXブックマーク由来（Stage 6I。収集元ではなく、利用者が選んだ投稿） */
    bookmark?: boolean;
    /** 取得の経路（X API／公開oEmbed） */
    xVia?: "api" | "oembed";
    /** 保存済みの画像が取得できず、X APIで投稿を取り直した（1回だけ） */
    refetched?: boolean;
    attempts: number;
    /** 一覧の表示から読み取れた締切・地域（AI解析の優先順位と、解析前の再確認に使う） */
    hints?: ListHints;
    /** 内容の変更を検出した再解析（既存の抽選の更新提案を作る） */
    changed?: boolean;
    /** 同じURLで新しい抽選回が始まった（前回の締切より後の応募期間） */
    newRound?: boolean;
    /** 取得が制限されたページのため、まとめサイトの一覧の表示（二次情報）から読み取った */
    viaList?: boolean;
    /** 過去の代替成功の記録により、取得制限のURLへ再アクセスせずに読み取った */
    altSkipped?: boolean;
    /** 一覧の表示から読み取ることになった元の取得失敗の原因 */
    viaKind?: FailKind;
    /** 優先収集メモに関連する候補 */
    memoId?: string;
    /** AI解析の実行理由（内部ログ） */
    reason?: AiReason;
    /** 一覧から card/fields/hints を取得した時刻 */
    listSeenAt?: string;
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const jstMonthStart = (now: Date) => {
  const m = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(now);
  return new Date(`${m}-01T00:00:00+09:00`).toISOString();
};
const host = (u: string) => {
  try {
    return new URL(u).hostname.slice(0, 255);
  } catch {
    return null;
  }
};

/** 世帯の収集条件・収集元の初期値を用意する（無いときだけ。既存の設定は変えない） */
export async function ensureCollectionDefaults(db: Db, householdId: string): Promise<void> {
  const s = await db.from("collection_settings").select("id").eq("household_id", householdId).limit(1);
  if (!s.error && (s.data ?? []).length === 0) await db.from("collection_settings").insert({ household_id: householdId });
  const src = await db.from("collection_sources").select("id").eq("household_id", householdId).limit(1);
  if (!src.error && (src.data ?? []).length === 0) {
    await db.from("collection_sources").insert([
      { household_id: householdId, kind: "web", name: "pokeso", url: "https://pokeso.jp/chusen", adapter: "pokeso" },
      { household_id: householdId, kind: "web", name: "トレカ日和", url: "https://torecabiyori.com/chusen/pokemon/", adapter: "torecabiyori" },
      { household_id: householdId, kind: "x", name: "OnchainOutlaw", x_username: "OnchainOutlaw", adapter: "x" },
      { household_id: householdId, kind: "x", name: "pokecachan", x_username: "pokecachan", adapter: "x" },
    ]);
  }
}

export function conditionsFromRow(row: Record<string, unknown>): CollectionConditions {
  return normalizeConditions({
    prefectures: row.prefectures,
    includeOnline: row.include_online,
    maxDistanceKm: row.max_distance_km,
    applyMethods: row.apply_methods,
    receiveMethods: row.receive_methods,
    reqInclude: row.req_include,
    reqExclude: row.req_exclude,
    productMode: row.product_mode,
    productIds: row.product_ids,
    statusMode: row.status_mode,
    trackUpcoming: row.track_upcoming,
  });
}

type StatKey = "ai_log_failures" | "discovered_new" | "discovered_initial" | "changed" | "duplicates" | "excluded" | "ai_calls" | "ai_success" | "ai_failed" | "registered_new" | "provisional_registered" | "failed_jobs" | "x_posts_manual" | "updated_existing" | "review_added" | "input_tokens" | "output_tokens" | "cost_jpy" | "queue_remaining" | "registered_caution" | "excluded_region";
export type StatDelta = Partial<Record<StatKey, number>> & { /** 確認待ちになった理由の分類ごとの件数（Stage 7A） */ reasons?: Record<string, number> };

/** 日別統計(日本時間の日付)への原子的な加算。統計の失敗で本処理を止めない */
export async function bumpStats(db: Db, householdId: string, now: Date, delta: StatDelta): Promise<void> {
  const { reasons, ...nums } = delta;
  const clean: Record<string, unknown> = Object.fromEntries(Object.entries(nums).filter(([k, v]) => typeof v === "number" && (v !== 0 || k === "queue_remaining")));
  if (reasons && Object.keys(reasons).length > 0) clean.reasons = reasons;
  if (Object.keys(clean).length === 0) return;
  await db.rpc("bump_collection_stats", { p_household: householdId, p_day: jstDayString(now), p_delta: clean as unknown as Json }).then(() => undefined, () => undefined);
}

/** AI読み取りの利用記録（既存の費用管理と同じテーブル）と、日別統計（回数・成功/失敗・トークン・費用）。入力した本文・画像そのものは保存しない */
async function logAi(deps: CollectDeps, result: ExtractResult, sourceUrl: string, reason: AiReason = "initial"): Promise<number> {
  const usedAi = result.ok || result.code !== "fetch_failed";
  let cost = 0;
  if (usedAi) {
    const input = result.usage?.input ?? 0;
    const output = result.usage?.output ?? 0;
    cost = result.engine === "anthropic" ? (estimateAiCostJpy(result.model, input, output, deps.usdJpy ?? USD_JPY_ESTIMATE) ?? 0) : 0;
    const valid = result.ok || result.code === "not_lottery" || result.code === "nothing_found";
    await bumpStats(deps.db, deps.householdId, deps.now, { ai_calls: 1, ai_success: valid ? 1 : 0, ai_failed: valid ? 0 : 1, input_tokens: input, output_tokens: output, cost_jpy: Math.round(cost * 10000) / 10000 });
  }
  const status = result.ok ? (result.extraction.applyDeadline.precision === "unknown" || result.extraction.items.length === 0 ? "partial" : "ok") : result.code === "rate_limited" ? "rate_limited" : result.code === "fetch_failed" ? "fetch_failed" : "failed";
  // システム実行（cron・ワーカー。ログインなし）は user_id なし＋actor_kind=system。利用者の手動実行は従来どおり利用者として記録する
  const system = !deps.canRegister;
  const row = {
    household_id: deps.householdId,
    trigger_reason: reason,
    kind: result.kind,
    engine: result.ok ? result.engine : (result.engine ?? "none"),
    status,
    source_host: host(sourceUrl),
    input_tokens: result.usage?.input ?? null,
    output_tokens: result.usage?.output ?? null,
    model: result.engine === "anthropic" ? (result.model ?? null) : null,
    prompt_version: result.ok ? result.promptVersion : PROMPT_VERSION,
    extraction: result.ok ? (result.extraction as unknown as Json) : null,
  };
  let ins = await deps.db.from("ai_extraction_logs").insert({ ...row, actor_kind: system ? "system" : "user", ...(system ? { user_id: null } : {}) } as never);
  // ログイン中の利用者の接続で動いている場合（システム行は書けない=RLS）は、利用者の実行として保存する
  if (ins.error?.code === "42501" && system) ins = await deps.db.from("ai_extraction_logs").insert({ ...row, actor_kind: "user" } as never);
  // 保存の失敗を見逃さない: 原因を記録し（秘密・本文は含めない）、日別統計に失敗件数を残す。費用は日別統計側にも記録済みなので予算の判定は過少にならない
  if (ins.error && usedAi) {
    console.error(`[ai-log] ai_extraction_logs の保存に失敗しました code=${ins.error.code ?? "?"} actor=${system ? "system" : "user"} reason=${reason}`);
    await bumpStats(deps.db, deps.householdId, deps.now, { ai_log_failures: 1 });
  }
  return cost;
}

/** 自動収集の1時間あたりのAI読み取りの上限（外部APIへの負荷を抑えるための内部の速度制限。費用の制御ではなく、日次の件数上限でもない） */
const COLLECTOR_HOURLY_RATE = 120;

/**
 * 今回のAI読み取りの上限。日次の件数上限はない（Stage 5T で廃止）。費用は月額予算で制御する。
 *  - 自動AI解析がONで、月額予算が残っている（残額が1回の見込みに満たない分は始めない。実際の呼び出しの直前に、予約でも並列実行を含めて予算内かを確認する）
 *  - 1時間あたりの速度制限（外部APIの負荷対策）
 */
export async function aiAllowance(deps: CollectDeps, perRun: number): Promise<{ allowed: number; note: string; stop: "budget" | "auto_off" | "hourly" | "none_ai" | null }> {
  if (!deps.extractor) return { allowed: 0, note: "AIが未設定のため、読み取りは行いません", stop: "none_ai" };
  if (deps.extractor.engine !== "anthropic") return { allowed: perRun, note: "", stop: null };
  let budgetLeft = Number.POSITIVE_INFINITY;
  try {
    const b = await monthBudget(deps.db, deps.householdId);
    deps.usdJpy = b.rate;
    if (!b.autoAiEnabled) return { allowed: 0, note: "自動AI解析がOFFに設定されているため、読み取りは行いません", stop: "auto_off" };
    budgetLeft = budgetCallsLeft(b.budgetJpy, b.costJpy);
    if (b.blocked || budgetLeft <= 0) return { allowed: 0, note: "今月のAI予算に達したため、新しい解析を停止しています", stop: "budget" };
  } catch {
    /* 予算の取得に失敗したときは、安全側に1件ずつ進める（実際の呼び出しの直前の予約で再確認する） */
    budgetLeft = 1;
  }
  const hourly = Number(process.env.COLLECTOR_AI_HOURLY_LIMIT) > 0 ? Number(process.env.COLLECTOR_AI_HOURLY_LIMIT) : COLLECTOR_HOURLY_RATE;
  const h = await deps.db.from("ai_extraction_logs").select("id", { count: "exact", head: true }).eq("household_id", deps.householdId).gte("created_at", new Date(deps.now.getTime() - 3600_000).toISOString()).neq("status", "not_configured");
  const left = hourly - (h.count ?? 0);
  if (left <= 0) return { allowed: 0, note: "1時間あたりのAI読み取りの速度制限に達しているため、続きは次回に回します", stop: "hourly" };
  return { allowed: Math.max(0, Math.min(perRun, left, budgetLeft)), note: left < perRun ? "AI読み取りの速度制限に近いため、続きは次回に回します" : "", stop: null };
}

/**
 * 実際のAI呼び出しの直前に、月額予算の予約を取る（並列ワーカー・並列バッチでも予算を超えない）。
 * 予約は見込み額（実測の平均×3、最大8円）で、今月の実費＋有効な予約＋今回の見込みが予算内のときだけ許可される。
 * 実費（ai_extraction_logs）と予約（見込み）は別の値で、予約は完了後30秒で失効する。
 */
export interface BudgetSnapshot {
  budgetJpy: number;
  costJpy: number;
  estimateJpy: number;
}
export async function budgetSnapshot(deps: CollectDeps): Promise<BudgetSnapshot | null> {
  if (deps.extractor?.engine !== "anthropic") return null;
  try {
    const b = await monthBudget(deps.db, deps.householdId);
    return { budgetJpy: b.budgetJpy, costJpy: b.costJpy, estimateJpy: reserveEstimateJpy(b.avgPerCallJpy) };
  } catch {
    return { budgetJpy: 0, costJpy: 0, estimateJpy: reserveEstimateJpy(null) }; // 取得に失敗したときは予算0として扱い、呼び出さない
  }
}
export async function reserveBudget(deps: CollectDeps, snap: BudgetSnapshot | null): Promise<{ ok: true; release: () => Promise<void> } | { ok: false }> {
  if (!snap) return { ok: true, release: async () => undefined }; // 有料のAIを使わないエンジン
  const { data, error } = await deps.db.rpc("reserve_ai_budget", { p_household: deps.householdId, p_est_jpy: snap.estimateJpy, p_month_cost_jpy: snap.costJpy, p_budget_jpy: snap.budgetJpy, p_ttl_seconds: 300 });
  if (error || !data) return { ok: false };
  const id = data as unknown as string;
  return { ok: true, release: async () => void (await deps.db.rpc("release_ai_budget", { p_id: id }).then(() => undefined, () => undefined)) };
}

export { isReady };

export async function appendSourceUrl(db: Db, lotteryId: string, url: string): Promise<boolean> {
  const { data } = await db.from("lotteries").select("source_urls").eq("id", lotteryId).maybeSingle();
  if (!data) return false;
  const cur = data.source_urls ?? [];
  if (cur.includes(url) || cur.length >= 10) return false;
  // 抽選の確定情報には触れず、情報源URLの追加だけを行う
  // 自動処理による更新の印（cautions_updated_at）も更新する。利用者の手動編集と区別して、注意付きの抽選の自動補完（Stage 7A）を止めないため
  const { error } = await db.from("lotteries").update({ source_urls: [...cur, url], cautions_updated_at: new Date().toISOString() }).eq("id", lotteryId);
  return !error;
}

interface CandidateRow {
  id: string;
  dedupe_key: string;
  source_url: string | null;
  title: string;
  draft: Json | null;
  status: string;
  fetched_at: string;
  source_id: string | null;
  lottery_id: string | null;
  attempts: number;
  job_state: string;
  kind: string;
  created_at: string;
  due_at?: string | null;
  ai_calls?: number;
  cost_jpy?: number | string;
  hold_count?: number;
  triage?: string | null;
}


/**
 * X投稿の取得済み情報（解析後も草稿に残す）。再解析で同じ投稿を再取得しないための保存で、投稿ID・投稿者・日時・本文・画像URL・引用元・リンクと、
 * 画像の扱い（見つかった／取得できた／AIへ渡した）、画像から読み取れた項目を持つ。本文は上限を設け、取得から30日を過ぎたら再取得する（queued.ts）。
 */
function xpostSnapshot(q: QueuedPayload["queued"], evidence: Partial<Record<string, { source?: string }>>, nowIso: string): Record<string, unknown> | null {
  const p = q.post;
  if (!p) return null;
  const fromImage = Object.entries(evidence).filter(([, v]) => (v?.source ?? "").startsWith("画像")).map(([k]) => k);
  return {
    id: p.id,
    username: p.username ?? "",
    ...(p.profile ? { profile: p.profile } : {}),
    createdAt: p.createdAt,
    text: safeSlice(p.text, 4000),
    images: p.images.slice(0, 8),
    links: p.links.slice(0, 5),
    ...(p.quoted ? { quoted: { id: p.quoted.id, username: p.quoted.username, ...(p.quoted.profile ? { profile: p.quoted.profile } : {}), createdAt: p.quoted.createdAt, text: safeSlice(p.quoted.text, 2000), images: p.quoted.images.slice(0, 8), links: p.quoted.links.slice(0, 5) } } : {}),
    fetchedAt: nowIso,
    via: q.xVia ?? null,
    basis: q.relevanceBasis ?? null,
    imageStats: q.imageStats ?? null,
    extractedFromImage: fromImage,
  };
}

/** 取得とAI読み取り(通信が中心の処理)。複数の候補を並行して実行できる。判定・登録は processCandidate が順番に行う */
async function extractFor(deps: CollectDeps, q: QueuedPayload["queued"]): Promise<ExtractResult> {
  let result: ExtractResult;
  const extractor = deps.extractor!;
  if (q.kind === "x_post" && q.post) {
    const p = q.post;
    // 本文＋添付画像（複数・縦長は分割）＋リンク先の本文を統合（単件・一括・共有と共通の処理）
    const rich = await enrichXPost(p, { fetchPage: deps.fetchPage, fetchImage: deps.fetchImage });
    // 画像は「見つかった／取得できた／AIへ渡した」を別々に記録する（取得とAI解析を混同しない）
    q.imageStats = rich.stats;
    q.xVia = "api";
    // 保存済みの画像URLがすべて取得できない（期限切れ等）ときは、1回だけX APIで投稿を取り直す（予算の範囲内。X APIが使えなければ従来どおり再試行）
    if (rich.stats.found > 0 && rich.stats.fetched === 0 && deps.xClient && !q.refetched) {
      const inner: QueuedPayload["queued"] = { ...q, kind: "x_oembed", post: undefined, refetched: true };
      const r = await extractFor(deps, inner);
      q.post = inner.post;
      q.imageStats = inner.imageStats;
      q.xVia = inner.xVia;
      return r;
    }
    // 画像が情報の中心の投稿で、画像を1枚も取得できなかったときは、本文だけで有料のAI解析をしない（後で再試行する）
    if (rich.stats.found > 0 && rich.stats.fetched === 0 && q.relevanceBasis === "image") {
      return { ok: false, kind: "image", code: "fetch_failed", message: `添付画像${rich.stats.found}枚を取得できませんでした（画像が情報の中心の投稿のため、解析を見送りました）`, suggest: "image" };
    }
    const kind = rich.images.length > 0 ? "image" : "x_url";
    const notes = rich.stats.found > 0 && rich.stats.fetched < rich.stats.found ? [`画像未取得: 添付画像${rich.stats.found}枚のうち${rich.stats.fetched}枚を取得できました`] : [];
    result = await extractFromRequest({ kind, text: rich.text, images: rich.images.length ? rich.images : undefined, sourceUrl: q.url, postedOn: p.createdAt.slice(0, 10) || undefined, now: deps.now }, kind, extractor, deps.now, notes);
  } else {
    // 一覧の情報（二次情報）。取得が制限されたページの代替解析で使う。店舗名・商品名は見出し付きで先頭に置く（AIが推測せずに済むように）
    const listText = [q.fields?.store ? `店舗: ${q.fields.store}` : "", q.fields?.product ? `商品: ${q.fields.product}` : "", q.title, q.card ?? q.context].filter(Boolean).join("\n").trim();
    // 過去に「取得制限（robots）で、一覧の文章による代替が成功」と分かっている応募サービス・ドメインは、同じ制限URLへ再アクセスせず、最初から代替で読み取る
    if (q.kind === "web_page" && listText.length >= 25) {
      const plan = await altPlanFor(deps.db, deps.householdId, q.url, deps.now).catch(() => null);
      if (plan?.skipFetch) {
        const alt = await extractFromRequest({ kind: "text", text: listText, sourceUrl: q.url, now: deps.now }, "text", extractor, deps.now, ["取得が制限されている応募先のため、まとめサイトの一覧の表示（二次情報）から読み取りました"]);
        if (alt.ok) {
          q.viaList = true;
          q.viaKind = plan.failKind;
          q.altSkipped = true;
          return alt;
        }
      }
    }
    const xRich = makeXRichFetcher({ db: deps.db, householdId: deps.householdId, client: deps.xClient, enrich: { fetchPage: deps.fetchPage, fetchImage: deps.fetchImage }, oembed: deps.fetchOembed, now: deps.now });
    const fetchXRich: typeof xRich = async (u) => {
      const r = await xRich(u);
      if (r.ok) {
        q.imageStats = { found: r.imagesFound, fetched: r.imagesUsed, sent: r.images.length };
        q.xVia = r.via;
        if (r.post) q.post = r.post;
      }
      return r;
    };
    result = await runExtraction({ kind: q.kind === "x_oembed" ? "x_url" : "url", url: q.url }, { extractor, now: deps.now, fetchPage: deps.fetchPage, fetchX: deps.fetchOembed, fetchXRich });
    // 取得が制限された外部ページ（ロボット制限）は回避しない。代わりに、取得できたまとめサイトの一覧の表示（二次情報）から読み取る
    if (!result.ok && result.code === "fetch_failed" && q.kind === "web_page" && ["robots", "js_render"].includes(classifyFailure(result.message).kind) && listText.length >= 25) {
      const alt = await extractFromRequest({ kind: "text", text: listText, sourceUrl: q.url, now: deps.now }, "text", extractor, deps.now, ["取得が制限されたページのため、まとめサイトの一覧の表示（二次情報）から読み取りました"]);
      if (alt.ok) {
        q.viaList = true;
        q.viaKind = classifyFailure(result.message).kind;
        result = alt;
      }
    }
  }
  return result;
}

interface Outcome {
  usedAi: boolean;
  registered: boolean;
  /** AIの呼び出し自体の失敗（連続失敗の自動停止の判定に使う） */
  aiFailed: boolean;
}

/**
 * 投稿者のXアカウント（表示名・プロフィール）から系列・店舗・所在地を特定する（Stage 6H）。
 * まとめアカウントの投稿は引用元（公式）の投稿者を対象にする。特定できた対応は保存し、次回以降に再利用する。特定できなければ null。
 */
async function identifyPostAuthor(deps: CollectDeps, data: AppData, q: QueuedPayload["queued"], author: string | null): Promise<AccountIdentity | null> {
  const post = q.post;
  const ids = (deps.xIdentities ??= await loadXIdentities(deps.db, deps.householdId));
  // 確定済みの対応は、アカウントID(固定)を最優先し、なければユーザー名で探す（Stage 6N）
  const run = (username: string, profile: XProfile | undefined, uid?: string) => identifyAccount({ username, profile, chains: data.chains, stores: data.stores, saved: (uid ? ids.get(`id:${uid}`) : undefined) ?? ids.get(username) ?? null });
  const isAgg = (u: string) => !!deps.sourceCtx?.aggregatorAccounts && [...deps.sourceCtx.aggregatorAccounts].some((a) => a.toLowerCase() === u);
  let id = author && !isAgg(author) ? run(author, post?.profile, post?.authorId) : null;
  const quotedUser = post?.quoted?.username ? normUsername(post.quoted.username) : "";
  if ((!id || id.kind === "aggregator" || id.kind === "unknown") && quotedUser && !isAgg(quotedUser)) {
    const qi = run(quotedUser, post?.quoted?.profile);
    if (qi.kind === "store" || qi.kind === "chain") id = qi;
  }
  if (!id || (id.kind !== "store" && id.kind !== "chain")) return null;
  const uid = id.username === author ? post?.authorId : undefined;
  if (id.storeBasis !== "saved" && (await saveXIdentity(deps.db, deps.householdId, id, ids.get(id.username), uid))) {
    if (uid) ids.set(`id:${uid}`, { username: id.username, chainName: id.chainName, storeName: id.storeName, chainId: id.chainId, storeId: id.storeId, prefecture: id.prefecture, basis: id.prefectureBasis || "name" });
    ids.set(id.username, { username: id.username, chainName: id.chainName, storeName: id.storeName, chainId: id.chainId, storeId: id.storeId, prefecture: id.prefecture, basis: id.prefectureBasis || "name" });
  }
  return id;
}

/** 登録した抽選の店舗の都道府県が空のとき、確実な根拠のある都道府県だけを補う（既に入っている値は変えない） */
async function fillStorePrefecture(db: Db, lotteryId: string, pref: string): Promise<void> {
  if (!pref || !PREFECTURE_LIST.includes(pref)) return;
  const { data } = await db.from("lotteries").select("store_id").eq("id", lotteryId).maybeSingle();
  if (!data?.store_id) return;
  await db.from("stores").update({ prefecture: pref }).eq("id", data.store_id).eq("prefecture", "").neq("sales_kind", "online_only");
}

/** 読み取り結果の判定と記録。処理状態(job_state)・試行回数・次回実行時刻・エラーをDBに残す */
async function processCandidate(deps: CollectDeps, data: AppData, cond: CollectionConditions, autoRegister: boolean, c: CandidateRow, q: QueuedPayload["queued"], result: ExtractResult, rules: ExclusionRule[] = [], userRules: UserRule[] = []): Promise<Outcome> {
  const { db } = deps;
  const nowIso = deps.now.toISOString();
  const clear = { lease_until: null, locked_by: null };
  // 実施した取得方法・元の情報源と応募サービスのホスト・最後に取得できた情報（内部ログ。設定画面には出さない）
  const methods = [q.kind === "x_post" ? "X投稿" : q.kind === "x_oembed" ? "X埋め込み" : "直接取得", ...(q.viaList ? ["一覧の表示（二次情報）"] : [])];
  const originHost = hostOf(c.source_url ?? q.url);
  const trace: Record<string, unknown> = { fetch_methods: methods, origin_host: originHost, service_host: hostRole(originHost) === "apply_service" ? originHost : null, last_good: { title: q.title.slice(0, 120), context: (q.card ?? q.context).slice(0, 300), hints: q.hints ?? null } };
  // この候補で使ったAI回数・費用（収集結果の集計に使う。logAi のあとで設定）
  let acct: Record<string, unknown> = { ...trace };
  // 完了(completed/skipped/review)の記録。結果(status)は従来どおり別に持つ
  const finish = async (jobState: "completed" | "skipped" | "review", patch: Record<string, unknown>, stat?: StatDelta) => {
    await db
      .from("collection_candidates")
      .update(deepClean({ ...patch, ...acct, job_state: jobState, completed_at: nowIso, resolved_at: nowIso, last_error: null, analyzed_version: PROMPT_VERSION, last_checked_at: nowIso, ...clear }) as never)
      .eq("id", c.id);
    if (stat) await bumpStats(db, deps.householdId, deps.now, stat);
  };
  // 失敗: 一時的なものは指数バックオフで再試行(15分→1時間→4時間)。上限・永続エラーは隔離する(無限に再解析しない)
  const fail = async (message: string) => {
    const external = q.kind === "web_page"; // まとめサイトの一覧から辿った外部ページ
    const cls = classifyFailure(message, { external });
    const delay = cls.permanent ? null : backoffMs(c.attempts);
    // 受付終了後の取得失敗は、失敗ではなく「受付終了」として除外する（失敗件数に数えず、原因は記録する）
    const lapsed = c.due_at ? new Date(c.due_at).getTime() < deps.now.getTime() : false;
    // 取得困難の記録（原因・回数・最終確認日・代替取得の成否）。代替の取得方法（一覧の表示）を試した結果も残す
    if (!lapsed && (delay === null || cls.permanent)) await recordHardSource(db, deps.householdId, deps.now, { url: c.source_url ?? q.url, failKind: cls.kind, alt: q.viaList === undefined && cls.permanent ? { source: "list_text", ok: false } : undefined });
    if (lapsed) {
      await db.from("collection_candidates").update({ status: "excluded", job_state: "skipped", fail_kind: "expired", triage: "auto_exclude", triage_reason: "受付終了のため自動で除外しました", reasons: ["受付終了のため取得しませんでした（応募締切を過ぎています）", `取得の失敗理由: ${FAIL_KIND_LABEL[cls.kind]}`], last_error: message.slice(0, 300), completed_at: nowIso, resolved_at: nowIso, ...acct, ...clear }).eq("id", c.id);
      await bumpStats(db, deps.householdId, deps.now, { excluded: 1 });
    } else if (delay === null) {
      // 即時の再試行を使い切った／再試行しても変わらない失敗。恒常的でなければ長い間隔の保留（自動再調査）に、締切が近い・代替も無い場合は要手動確認へ
      const hd = decideHold({ now: deps.now, dueAt: c.due_at ? new Date(c.due_at) : null, gaps: [message], holdCount: c.hold_count ?? 0, failKind: cls.kind, altTried: cls.permanent, important: !!q.memoId });
      if (hd.triage === "auto_retry") {
        await db.from("collection_candidates").update({ status: "pending", job_state: "retry", attempts: 0, fail_kind: cls.kind, reasons: [message, `原因: ${FAIL_KIND_LABEL[cls.kind]}`, hd.reason], last_error: message.slice(0, 300), ...triagePatch(hd, c, deps.now), ...acct, ...clear }).eq("id", c.id);
      } else if (hd.triage === "auto_exclude") {
        await db.from("collection_candidates").update({ status: "excluded", job_state: "skipped", fail_kind: "expired", reasons: [hd.reason], last_error: message.slice(0, 300), completed_at: nowIso, resolved_at: nowIso, ...triagePatch(hd, c, deps.now), ...acct, ...clear }).eq("id", c.id);
        await bumpStats(db, deps.householdId, deps.now, { excluded: 1 });
      } else {
        await db.from("collection_candidates").update({ status: "failed", job_state: "failed", fail_kind: cls.kind, reasons: [message, `原因: ${FAIL_KIND_LABEL[cls.kind]}`, hd.reason], last_error: message.slice(0, 300), completed_at: nowIso, ...triagePatch(hd, c, deps.now), ...acct, ...clear }).eq("id", c.id);
        await bumpStats(db, deps.householdId, deps.now, { failed_jobs: 1 });
      }
    } else {
      await db
        .from("collection_candidates")
        .update({ status: "pending", job_state: "retry", fail_kind: cls.kind, reasons: [message, `再試行待ち（${c.attempts}/${MAX_ATTEMPTS}回目の失敗。原因: ${FAIL_KIND_LABEL[cls.kind]}）`], last_error: message.slice(0, 300), next_run_at: new Date(deps.now.getTime() + delay).toISOString(), ...acct, ...clear })
        .eq("id", c.id);
    }
  };

  const callCost = await logAi(deps, result, q.url, q.reason ?? "initial").catch(() => 0);
  if (result.ok || result.code !== "fetch_failed") acct = { ai_calls: (c.ai_calls ?? 0) + 1, cost_jpy: Math.round(((Number(c.cost_jpy) || 0) + callCost) * 10000) / 10000 };
  if (!result.ok) {
    if (result.code === "not_lottery" || result.code === "nothing_found") {
      await finish("skipped", { status: "excluded", reasons: ["抽選の告知とは判断できませんでした"], draft: null }, { excluded: 1 });
      return { usedAi: true, registered: false, aiFailed: false };
    }
    await fail(result.message);
    return { usedAi: result.code !== "fetch_failed", registered: false, aiFailed: result.code === "ai_failed" || result.code === "rate_limited" };
  }

  // 公式Xアカウントの対応づけ（利用者が登録したものだけ）。告知から読み取れなかった系列/店舗だけを補い、食い違いは上書きせず注意にする
  const author = q.post?.username ? normUsername(q.post.username) : usernameFromPostUrl(q.url);
  // Xアカウントの表示名・プロフィールから、系列・店舗・所在地を特定する（Stage 6H）。まとめアカウントの投稿は、引用元（公式）の投稿者を見る。告知から読み取れた項目は上書きしない
  const idn = await identifyPostAuthor(deps, data, q, author);
  // Xユーザー名（@Rises_eStore など）をそのまま系列名にしない。表示名とマスター（正式名称・別名）で決め、特定できなければ空のまま確認待ちにする（Stage 6N）
  const ex0 = author ? { ...result.extraction, chainName: dropUsernameChain(result.extraction.chainName, author, data.chains) } : result.extraction;
  const idHint = idn ? identityHint(ex0, idn) : null;
  let baseEx = idHint ? { ...ex0, chainName: idHint.chainName, storeName: idHint.storeName, prefecture: idHint.prefecture } : ex0;
  const chainWarn: string[] = [];
  if (author && !baseEx.chainName.trim()) {
    const xc = resolveXChain({ extracted: "", username: author, displayName: q.post?.profile?.name ?? q.post?.quoted?.profile?.name ?? "", saved: deps.xIdentities?.get(author) ?? null, chains: data.chains });
    if (xc.chainName) baseEx = { ...baseEx, chainName: xc.chainName };
    else chainWarn.push(...xc.warnings);
  }
  const hint = author ? applyAccountHint(baseEx, deps.xLinks?.get(author), data) : null;
  const draft = buildDraft(hint?.extraction ?? baseEx, data, { sourceUrl: q.url });
  draft.warnings.push(...chainWarn);
  if (hint && hint.warnings.length > 0) draft.warnings.push(...hint.warnings);
  if (idn && idn.notes.length > 0 && idn.storeBasis === "ambiguous") draft.warnings.push(...idn.notes);
  // 自動収集は要チェックにせず、応募記録も作らない
  const input: LotteryInput = { ...draft.input, isManaged: false, applications: [], sourceUrls: [...new Set([...(draft.input.sourceUrls ?? []), q.url])].slice(0, 10) };
  // ---- 読み取れなかった項目を、まとめサイトの一覧の表示（二次情報）で補う。補った項目は根拠として明示し、確定情報とは区別する
  const secondary: string[] = [...(hint?.used ?? []), ...(idHint?.used ?? [])];
  // 応募時に店舗を選ぶ抽選（トレカキャピタル・一部のLivePocketなど）: 店舗を決めず「応募時に店舗選択」として登録する（Stage 6N）
  if (!input.store.id && (!input.store.name.trim() || input.store.name === SELECT_STORE_PLACEHOLDER) && detectStoreSelect({ texts: [q.title, q.context, q.card, q.post?.text, input.conditionsText], chainName: input.chain.name })) {
    const ph = data.stores.find((s) => s.chainId === input.chain.id && s.name === SELECT_STORE_PLACEHOLDER);
    input.storeMode = "select_on_apply";
    input.store = { id: ph?.id ?? null, name: SELECT_STORE_PLACEHOLDER, prefecture: "" };
    draft.summary.store = ph ? "exact" : "none";
    secondary.push("応募時に店舗選択（店舗は応募者が応募時に選びます）");
  }
  // 複数のTCGを案内する投稿では、ポケモンカード以外の明細を外す（ポケモンカードの明細が残るときだけ）
  const dropIdx = new Set(otherTcgItemIndexes(input.items));
  if (dropIdx.size > 0) {
    input.items = input.items.filter((_, i) => !dropIdx.has(i));
    draft.summary.items = draft.summary.items.filter((_, i) => !dropIdx.has(i));
    secondary.push("ポケモンカード以外の商品を除いた明細");
  }
  const lh = q.hints;
  if (input.applyDeadline.precision === "unknown" && lh?.deadlineIso) {
    input.applyDeadline = { ...isoToFlex(lh.deadlineIso) };
    secondary.push("応募締切");
  } else if (input.applyDeadline.precision === "unknown" && lh?.deadlineDate) {
    input.applyDeadline = { precision: "date_only", date: lh.deadlineDate, time: "" };
    secondary.push("応募締切（日付のみ）");
  }
  if (input.receiveMethod === "unknown" && lh?.online) {
    input.receiveMethod = "shipping";
    secondary.push("受取方法（通販）");
  }
  // オンライン販売で店舗名が無い場合は、既存の運用に合わせて店舗名「オンライン」を使う（既存の店舗があればそれに紐付ける）
  if (!input.store.name.trim() && input.receiveMethod === "shipping" && input.chain.id) {
    const online = data.stores.find((s) => s.chainId === input.chain.id && !s.archived && (s.name === "オンライン" || s.salesKind === "online_only"));
    input.store = online ? { id: online.id, name: online.name, prefecture: "" } : { id: null, name: "オンライン", prefecture: "" };
    draft.summary.store = online ? "exact" : "none";
  } else if (!input.store.name.trim() && input.receiveMethod === "shipping") {
    input.store = { id: null, name: "オンライン", prefecture: "" };
  }
  // 店舗名「オンライン」を補ったあとで重複を判定し直す（buildDraft の時点では店舗が未確定で重複候補が空になり、同じオンライン抽選が二重登録されていた）
  draft.duplicates = findDuplicates(input, data.lotteries, q.url, data);
  if (q.viaList) secondary.push("全項目（取得制限のため、まとめサイトの一覧の表示から読み取り）");
  if (secondary.length > 0) {
    const note = "二次情報（まとめサイトの一覧・公式アカウントの対応づけ）から補った項目: " + secondary.join("・") + "。公式の告知で確認してください";
    input.memo = [input.memo, note].filter(Boolean).join("\n").slice(0, 2000);
  }
  const store = data.stores.find((s) => s.id === input.store.id);
  // 代替の取得方法（一覧の表示）で必要な情報を得られた → 取得困難の記録に「代替成功」として残し、次回以降に優先する（系列・店舗×応募サービス単位）
  // 取得制限が分かっている応募先を最初から代替で読み取った場合は、失敗を数え直さず、代替の成功だけを記録する（失敗日時を更新すると、制限の解除に気づけなくなる）
  if (q.viaList && q.altSkipped) await recordAltSuccess(db, deps.householdId, deps.now, { url: c.source_url ?? q.url, chainId: input.chain.id, storeId: input.store.id, source: "list_text" });
  else if (q.viaList) await recordHardSource(db, deps.householdId, deps.now, { url: c.source_url ?? q.url, chainId: input.chain.id, storeId: input.store.id, chainName: input.chain.name, storeName: input.store.name, failKind: q.viaKind ?? "robots", alt: { source: "list_text", ok: true } });
  // 収集元の除外ルール（利用者が指定した店舗・系列）に一致したら登録しない。理由は残す
  // 抽選の実施を示す文言があるか（「新商品が発売される」だけの告知を、抽選予告として追跡・統合しない）
  const wording = hasLotteryWording([q.post?.text, q.post?.quoted?.text, q.card, q.context, q.title, result.extraction.announcementMethod, result.extraction.notes, result.extraction.conditionsText, result.extraction.verificationText, ...Object.values(draft.evidence).map((e) => e?.quote)]);
  // ---- 複数情報源の項目単位の統合（Stage 6D）。保存済みの解析結果だけを使い、AIは呼ばない
  const sctx = (deps.sourceCtx ??= await loadSourceCtx(db, deps.householdId).catch(() => ({ officialAccounts: new Set<string>(), aggregatorAccounts: new Set<string>(), listHosts: new Set(["pokeso.jp", "torecabiyori.com"]) })));
  const sc = classifySource(q.url, sctx);
  const postId = q.post?.id ?? sc.postId;
  const quotedId = q.post?.quoted?.id;
  const mySource: FieldSource = { url: q.url, kind: q.viaList ? "list_site" : sc.kind, origin: quotedId ? `x:${quotedId}` : postId ? `x:${postId}` : q.viaList ? `list:${q.url}` : `u:${urlIdentity(q.url) ?? q.url}`, at: nowIso, ...(sc.account ? { account: sc.account } : {}), ...(postId ? { postId } : {}) };
  let myFields = provenanceFor(input, mySource);
  const openAll = await loadOpen(db, deps.householdId, sctx).catch((): OpenLite[] => []);
  let relatedIds: string[] = [];
  let old: OpenLite | null = null;
  let mergeLog: Record<string, unknown> | null = null;
  if (isSupplement(input)) {
    // 補足投稿（応募条件・発表方法だけの投稿）: 引用元・共通URL・同じ公式アカウント×系列×時刻で対象が一意に特定できるときだけ補完する
    const sm = matchSupplement(openAll, { input, postId, quotedId, replyToId: q.post?.replyToId, account: (q.post?.username ?? sc.account ?? "").toLowerCase() || undefined, postedAt: q.post?.createdAt || nowIso, urls: [q.url, ...(input.sourceUrls ?? [])] }, c.id);
    relatedIds = sm.related;
    if (sm.target) {
      const tgt = sm.target;
      const m = mergeSides({ input: tgt.input, summary: tgt.summary, fields: tgt.fields, source: tgt.source }, { input, summary: draft.summary, fields: myFields, source: mySource });
      const tRow = (await db.from("collection_candidates").select("draft,triage").eq("id", tgt.id).maybeSingle()).data;
      const tDraft = (tRow?.draft as Record<string, unknown> | null) ?? {};
      const tAssess = assessCompleteness(m.input, m.summary, { today: jstDayString(deps.now), conflict: conflictLabels(m.fields).length > 0 ? `情報源間で食い違う項目: ${conflictLabels(m.fields).join("・")}` : null, candidates: (tDraft.candidates as never) ?? undefined, modePending: !!tDraft.modePending });
      const logEntry = { at: nowIso, from: q.url, kind: "supplement", signal: sm.signal, filled: m.filled, updated: m.updated, conflicts: m.conflicts };
      await db.from("collection_candidates").update({ draft: deepClean({ ...tDraft, input: m.input, summary: m.summary, fields: m.fields, assessment: tAssess, mergeLog: [...((tDraft.mergeLog as unknown[]) ?? []), logEntry].slice(-20) }) as never, ...(tRow?.triage === "auto_retry" ? { next_run_at: nowIso } : {}) }).eq("id", tgt.id);
      await finish("skipped", { status: "excluded", triage: "auto_exclude", triage_reason: "補足投稿を統合", reasons: [`補足投稿を、同じ抽選の候補（${tgt.id.slice(0, 6)}）へ統合しました（${{ quote: "引用元・返信元", url: "共通の応募URL", account: "同じ公式アカウント・系列・時刻" }[sm.signal ?? "quote"]}で特定。補った項目: ${m.filled.map((k) => FIELD_LABEL[k]).join("・") || "なし"}）`], draft: { input, summary: draft.summary, fields: myFields, mergedInto: tgt.id, supplement: true }}, { excluded: 1 });
      return { usedAi: true, registered: false, aiFailed: false };
    }
  } else if (wording || (input.applyDeadline.precision !== "unknown" && !!input.applyDeadline.date)) {
    const om = matchOpen(openAll, input, c.id);
    relatedIds = om.related;
    if (om.match) {
      old = om.match;
      const m = mergeSides({ input, summary: draft.summary, fields: myFields, source: mySource }, { input: old.input, summary: old.summary, fields: old.fields, source: old.source });
      Object.assign(input, m.input);
      draft.summary = m.summary;
      myFields = m.fields;
      mergeLog = { at: nowIso, from: old.source.url, fromId: old.id, kind: "same_lottery", filled: m.filled, updated: m.updated, conflicts: m.conflicts };
    }
  }
  const exRule = matchExclusion(rules, { storeId: input.store.id, chainId: input.chain.id, url: q.url });
  if (exRule && (exRule.scope === "store" || exRule.scope === "chain")) {
    await db.from("collection_candidates").update({ status: "excluded", job_state: "skipped", triage: "auto_exclude", triage_reason: "収集元の除外ルールに一致", reasons: [`収集元の除外ルール（${exRule.label || exRule.scope}）に一致したため登録しませんでした`], draft: { input, summary: draft.summary, confirmedAt: nowIso } as unknown as Json, resolved_at: nowIso, completed_at: nowIso, ...acct, ...clear }).eq("id", c.id);
    await bumpStats(db, deps.householdId, deps.now, { excluded: 1 });
    return { usedAi: true, registered: false, aiFailed: false };
  }
  const dist = store ? storeDistance(data, store) : null;
  // 地域の判定には、店舗の登録 → 告知から読み取った都道府県 → 一覧に表示された都道府県の順で使う（マスターには推測で書き込まない）
  // 地域は、店舗マスター → 住所 → 告知・一覧の都道府県 → 店舗名の地域名・市区町村名の順に、根拠つきで判定する。複数店舗の一覧・曖昧な地名は不明のまま（地域外と断定しない）（Stage 7A）
  const region = judgeRegion({ masterPrefecture: store?.prefecture, address: store?.address, storeName: input.store.id ? "" : input.store.name, statedPrefecture: input.store.prefecture || lh?.prefecture || "" });
  const knownPref = region.prefecture;
  const texts = tcgTextsOf({ title: q.title, card: q.card, context: q.context, postText: q.post?.text, quotedText: q.post?.quoted?.text, products: productNamesOf(input) });
  // 利用者が確定した除外ルール（Stage 7H）も、地域・商品・通販の例外と同じ判定（evaluateCandidate）の中で評価する
  const areaSets = userRules.some((r) => r.kind === "area_chain") ? chainAreaSets(data, cond.prefectures) : undefined;
  const ev = evaluateCandidate(input, cond, { texts, prefecture: knownPref, storeKind: store?.salesKind ?? "physical", distanceKm: dist ? dist.km : null, now: deps.now, userRules, chainsInArea: areaSets?.chainsInArea, chainsWithStores: areaSets?.chainsWithStores });
  const { ready, missing, provisional } = isReady(draft, input);
  const stage = classifyStage(input, jstDayString(deps.now));
  // ---- 抽選予告の追跡（Stage 6C）
  // 抽選の実施を示す文言があるか（「新商品が発売される」だけの告知を、抽選予告として追跡しない）
  const isNotice = stage === "teaser" || stage === "partial";
  // 複数の画像・本文の内容が矛盾するときは、無理に確定せず利用者の判断にする
  const conflictText = [...draft.warnings, ...Object.values(draft.flags)].find((w) => typeof w === "string" && /矛盾|食い違/.test(w));
  const fieldConflicts = conflictLabels(myFields);
  const conflict = fieldConflicts.length > 0 ? `情報源間で食い違う項目があります: ${fieldConflicts.join("・")}` : conflictText ? `情報に矛盾の疑いがあります: ${String(conflictText).slice(0, 80)}` : null;
  // 続報の照合: 追跡中の予告のうち、系列・商品・店舗が同じものを一意に探す（決められないときは統合せず、関連候補として保持）。
  // 別の情報源が同じ抽選を告知した場合（片方にだけ受付開始日がある等、読み取れた項目が違っても）、同じ抽選として追跡を引き継ぐ
  // 具体的な系列がある受付前・詳細未発表の抽選（または追跡中の予告の続報で、まだ登録できないもの）だけを追跡する
  const wantTrack = cond.trackUpcoming && !!input.chain.name.trim() && wording && (ev.verdict === "upcoming" || isNotice || (stage === "upcoming" && !ready) || (!!old?.tracking && !ready));
  const startDate = input.applyStart.precision !== "unknown" && input.applyStart.date ? input.applyStart.date : null;
  const trackingEntries = old ? diffTracking(old.input, input, nowIso, q.url) : [];
  const trackingObj: Tracking | null = wantTrack || old?.tracking ? { ...inheritTracking(old?.tracking ?? null, nowIso, q.url, startDate, trackingEntries), ...(relatedIds.length > 0 ? { related: relatedIds } : {}) } : null;
  // 系列に手動で登録した条件（Stage 5R）との違い。手動条件は書き換えず、確認用に残す
  const regKinds = (data.chainConditions ?? []).filter((cc) => cc.chainId === input.chain.id).map((cc) => cc.kind);
  const cDiff = input.chain.id ? conditionDiff((input.requirementTags ?? []) as RequirementTag[], regKinds) : null;
  if (cDiff && regKinds.length > 0) draft.flags.conditions = [draft.flags.conditions, conditionDiffText(cDiff)].filter(Boolean).join(" / ");
  // 続報で元の予告の候補が不要になったときの整理（元の候補は削除せず、結果を記録して残す）
  const supersede = async (outcome: "registered" | "duplicate" | "tracking" | "excluded", lotteryId?: string) => {
    if (!old) return;
    const done = outcome === "registered" || outcome === "duplicate";
    const patch = done
      ? { status: "duplicate", job_state: "completed", lottery_id: lotteryId ?? null, triage: "auto_exclude", triage_reason: "続報により同じ抽選として整理", reasons: [outcome === "registered" ? `続報（${q.url}）で正式な抽選として登録されました` : "続報が登録済みの抽選と同じ内容でした"], manual_state: null, resolved_at: nowIso, completed_at: nowIso }
      : { status: "excluded", job_state: "skipped", triage: "auto_exclude", triage_reason: "続報の候補へ統合", reasons: [outcome === "tracking" ? `続報の候補（${q.url}）へ統合しました。同じ抽選として追跡を続けます` : "続報で収集条件の対象外と判断されました"], manual_state: null, resolved_at: nowIso, completed_at: nowIso };
    await db.from("collection_candidates").update(deepClean(patch) as never).eq("id", old.id);
  };
  const assess = assessCompleteness(input, draft.summary, { today: jstDayString(deps.now), conflict, candidates: draft.candidates, modePending: draft.modePending, verdict: ev.verdict, verdictReasons: ev.reasons });
  const stored = { input, flags: draft.flags, summary: draft.summary, evidence: draft.evidence, modePending: draft.modePending, warnings: draft.warnings.slice(0, 10), notices: result.notices.slice(0, 5), verdict: ev.verdict, ready, provisional, secondary, confirmedAt: nowIso, engine: result.engine, listInfo: listInfoFromQueued(q, nowIso), viaList: !!q.viaList, stage, xpost: xpostSnapshot(q, draft.evidence, nowIso), ...(trackingObj ? { tracking: trackingObj } : {}), ...(cDiff ? { conditionDiff: cDiff } : {}), fields: myFields, assessment: assess, ...(relatedIds.length > 0 ? { related: relatedIds } : {}), ...(mergeLog ? { mergeLog: [mergeLog] } : {}) } as unknown as Json;
  const due = input.applyDeadline.precision === "unknown" ? undefined : { due_at: new Date(input.applyDeadline.precision === "date_time" ? `${input.applyDeadline.date}T${input.applyDeadline.time || "00:00"}:00+09:00` : `${input.applyDeadline.date}T23:59:00+09:00`).toISOString() };

  // ---- 内容の変更を検出した再解析: 既存の抽選と比べ、更新の提案か新しい抽選回かを判断する（確定情報は自動では書き換えない）
  const lot = c.lottery_id ? data.lotteries.find((l) => l.id === c.lottery_id) : undefined;
  if (q.changed && lot) {
    if (isNewRound(input, lot)) {
      // 前回の締切より後に新しい応募期間が始まった → 別の抽選として扱う。元の抽選は変更しない
      const deadlineDate = input.applyDeadline.date || "";
      const key = `${c.dedupe_key.split("#")[0]}#${deadlineDate}`.slice(0, 500);
      await db.from("collection_candidates").upsert(
        { household_id: deps.householdId, source_id: c.source_id, dedupe_key: key, source_url: c.source_url, title: c.title, status: "pending", job_state: "pending", reasons: ["新しい抽選回（解析待ち）"], draft: { queued: { ...q, changed: false, newRound: true, attempts: 0, reason: "new_round" as AiReason } } as unknown as Json } as never,
        { onConflict: "household_id,dedupe_key", ignoreDuplicates: true },
      );
      await finish("completed", { reasons: ["再確認: 新しい抽選回が始まったため、別の抽選として扱います"], draft: c.draft, kind: "new" }, { discovered_new: 1 });
      return { usedAi: true, registered: false, aiFailed: false };
    }
    const changes = diffAgainstLottery(input, lot);
    if (changes.length === 0) {
      await finish("completed", { reasons: ["再確認: 変更はありません"], draft: c.draft, kind: "new" });
      return { usedAi: true, registered: false, aiFailed: false };
    }
    const base = (await db.from("lotteries").select("updated_at").eq("id", lot.id).maybeSingle()).data?.updated_at ?? null;
    await finish("review", {
      status: "pending",
      kind: "update",
      reasons: changes.map((x) => `${x.label}: ${x.before} → ${x.after}`),
      draft: { ...(c.draft as object), update: { changes, baseUpdatedAt: base, input } } as unknown as Json,
    }, { review_added: 1 });
    return { usedAi: true, registered: false, aiFailed: false };
  }

  const dups = q.newRound ? draft.duplicates.filter((d) => !d.reason.includes("情報源URL")) : draft.duplicates;
  const high = dups.find((d) => d.level === "high");
  if (high) {
    const added = await appendSourceUrl(db, high.lotteryId, q.url);
    // 注意付きで登録した抽選は、新しい情報で不足を補い、相違を再評価する（値のある項目・手動編集した抽選は上書きしない）（Stage 7A）
    const completed = await autoCompleteLottery(db, high.lotteryId, input, { official: mySource.kind === "official_site" || mySource.kind === "official_x", now: deps.now }).catch(() => null);
    await supersede("duplicate", high.lotteryId);
    await finish("completed", { status: "duplicate", lottery_id: high.lotteryId, reasons: [high.reason, added ? "既存の抽選に情報源URLを追加しました" : "既存の抽選と同じ情報です", ...(completed?.updated ? [`注意付きの抽選を自動補完しました: ${completed.filled.join("・") || "注意の再評価"}`] : [])], draft: stored, ...due }, { duplicates: 1, ...(completed?.updated ? { updated_existing: 1 } : {}) });
    return { usedAi: true, registered: false, aiFailed: false };
  }
  if (ev.verdict === "exclude") {
    await supersede("excluded");
    // 対象外の地域による自動除外は、情報元・日時・判定した地域・理由・根拠を残す（候補は削除せず、除外一覧から確認・戻せる）
    const byRegion = isRegionReason(ev.reasons) && !!region.prefecture;
    const storedEx = byRegion ? ({ ...(stored as object), exclusion: regionExclusionOf(region, { at: nowIso, source: q.url, reason: ev.reasons.join("・") }) } as unknown as Json) : stored;
    await finish("skipped", { status: "excluded", reasons: byRegion ? [...ev.reasons, `判定根拠: ${region.note}`] : ev.reasons, draft: storedEx, ...due }, { excluded: 1, ...(byRegion ? { excluded_region: 1 } : {}) });
    return { usedAi: true, registered: false, aiFailed: false };
  }
  // 予告・一部判明の告知に、抽選の文言が無い（新商品の発売予定などの告知）ときは、抽選予告として扱わない
  if (isNotice && !wording) {
    await finish("skipped", { status: "excluded", reasons: ["抽選の予告ではなく、発売予定などの告知と判断しました（抽選・応募に関する文言がありません）"], draft: stored, ...due }, { excluded: 1 });
    return { usedAi: true, registered: false, aiFailed: false };
  }
  // 受付前の予告は除外しない。詳細が確定していれば通常の登録対象、未発表なら再調査として保持する
  const stageGap = !ready && (stage === "teaser" || stage === "partial") ? [`${STAGE_LABEL[stage]}: 応募の日時が未発表または不明です`] : [];
  const reasons = [...(conflict ? [conflict] : []), ...stageGap, ...ev.reasons, ...missing, ...dups.map((d) => d.reason)];
  // 登録の判定（Stage 7A）: A=十分 → 通常登録 / B=情報不足・軽微な矛盾 → 注意付きで登録 / C=抽選として成立するか判断できない → 確認待ち
  const chainRow = data.chains.find((x) => x.id === input.chain.id);
  const decision = decideRegistration({ input, verdict: ev.verdict, verdictReasons: ev.reasons, missing, fields: myFields, duplicateCount: dups.length, stage, modePending: draft.modePending, textConflict: typeof conflictText === "string" ? conflictText : null, chainStoreSelectDefault: !!chainRow?.storeSelectDefault, storeResolved: !missing.some((m) => /店舗を確実に特定できません/.test(m)), now: nowIso });
  const canRegisterNow = (ev.verdict === "match" || ev.verdict === "review") && decision.grade !== "C";
  // 追跡する予告（受付前・詳細未発表）: 要手動確認へ送らず、続報を待って保持する。受付開始が近いほど短い間隔で再確認する
  if (wantTrack && !canRegisterNow) {
    const dueAtT = due ? new Date(due.due_at) : null;
    const hdT = decideHold({ now: deps.now, dueAt: dueAtT, gaps: reasons.length ? reasons : ["内容を確認してください"], holdCount: c.hold_count ?? 0, failKind: null, altTried: !!q.viaList, important: !!q.memoId, tracking: trackingObj ? { startDate: trackingObj.startDate, lastNewsAt: trackingObj.lastNewsAt } : null });
    if (hdT.triage === "auto_exclude") {
      await supersede("excluded");
      await finish("skipped", { status: "excluded", reasons: [hdT.reason], draft: stored, ...triagePatch(hdT, c, deps.now), ...due }, { excluded: 1 });
    } else {
      await supersede("tracking");
      const head = ev.verdict === "upcoming" ? `受付前の抽選として追跡しています（受付開始: ${startDate ?? "未発表"}）` : `${STAGE_LABEL[stage]}として追跡しています`;
      await finish("review", { status: "pending", reasons: [head, ...reasons.filter((r) => !r.startsWith(STAGE_LABEL[stage]))].slice(0, 10), draft: { ...(stored as object), queued: { ...q, changed: false } } as unknown as Json, ...triagePatch(hdT, c, deps.now), ...due }, { review_added: 1 });
    }
    return { usedAi: true, registered: false, aiFailed: false };
  }
  if (canRegisterNow) {
    if (autoRegister && (deps.canRegister || deps.serviceRegister)) {
      // 店舗を特定できないときの補正（系列の「店舗選択式を基本とする」設定、または仮の店舗名）。推測で店舗を決めない
      if (decision.patch?.storeMode === "select_on_apply") {
        const ph = data.stores.find((s) => s.chainId === input.chain.id && s.name === SELECT_STORE_PLACEHOLDER);
        input.storeMode = "select_on_apply";
        input.store = { id: ph?.id ?? null, name: SELECT_STORE_PLACEHOLDER, prefecture: "" };
      } else if (decision.patch?.store) input.store = decision.patch.store;
      const saved = await saveLottery(db, deps.householdId, null, input, deps.actor, { asService: !deps.canRegister });
      if (saved.ok) {
        // 自動収集の印。NEW表示は新規に把握した時点を基準にする。注意付きの登録は、注意情報（項目別・理由別）と信頼度を保存する
        await db.from("lotteries").update({ source_kind: "auto", is_new: true, registration_path: "auto", cautions: decision.cautions as unknown as Json, confidence: decision.confidence, cautions_updated_at: nowIso }).eq("id", saved.value.id);
        // 店舗の都道府県が空のままにならないよう、確実な根拠のある都道府県だけを補う（既に入っている値は変えない）
        await fillStorePrefecture(db, saved.value.id, input.receiveMethod === "shipping" ? "" : knownPref);
        const storedReg = trackingObj ? ({ ...(stored as object), tracking: { ...trackingObj, promotedAt: nowIso, promotedLotteryId: saved.value.id } } as unknown as Json) : stored;
        await supersede("registered", saved.value.id);
        const withCaution = decision.grade === "B";
        const storedCaution = withCaution ? ({ ...(storedReg as object), cautions: decision.cautions, confidence: decision.confidence } as unknown as Json) : storedReg;
        await finish("completed", { status: "auto_registered", triage: "auto_register", triage_reason: withCaution ? "注意付きで自動登録（不足・相違は注意として記録）" : "条件に一致し、情報が十分なため自動登録", lottery_id: saved.value.id, reasons: [...(withCaution ? [`注意付きで自動登録しました: ${decision.cautions.map((x) => x.message.replace(/（.*$/, "")).join("／")}`] : []), provisional.length > 0 ? `条件に一致したため自動登録しました（未登録の${provisional.join("・")}は仮登録。マスター管理で確認できます）` : "条件に一致し、情報が十分なため自動登録しました", ...(secondary.length > 0 ? [`${secondary.join("・")}は二次情報（まとめサイト）です`] : [])], draft: storedCaution, ...due }, { registered_new: 1, registered_caution: withCaution ? 1 : 0, provisional_registered: provisional.length > 0 ? 1 : 0 });
        return { usedAi: true, registered: true, aiFailed: false };
      }
      // 登録の失敗はシステム側で解決できない → 要手動確認
      await finish("review", { status: "pending", reasons: [`自動登録できませんでした: ${saved.error}`], draft: stored, ...triagePatch({ triage: "manual", reason: `自動登録に失敗しました: ${saved.error}`.slice(0, 200), nextMs: null, urgency: "unknown" }, c, deps.now), ...due }, { review_added: 1 });
      return { usedAi: true, registered: false, aiFailed: false };
    }
    await finish("review", { status: "pending", reasons: ["登録可能です（自動登録がオフのため、候補として保留しています）"], draft: stored, ...due }, { review_added: 1 });
    return { usedAi: true, registered: false, aiFailed: false };
  }
  // ---- 登録できなかった候補: 自動再調査（保留）／要手動確認／自動除外に振り分ける（不明な項目を理由に、すぐ確認待ちへ送らない）
  const gaps = reasons.length ? reasons : ["内容を確認してください"];
  const dueAt = due ? new Date(due.due_at) : c.due_at ? new Date(c.due_at) : null;
  // 情報充実度 D・E は、要手動確認へ送らず、低優先度の自動追跡・再調査にとどめる（利用者の判断が要るもの・締切が近いものを除く）
  const hd = lowInfoOverride(decideHold({ now: deps.now, dueAt, gaps, holdCount: c.hold_count ?? 0, failKind: q.viaKind ?? null, altTried: !!q.viaList, important: !!q.memoId }), assess.rank, dueAt, deps.now);
  if (old && hd.triage !== "auto_exclude") await supersede("tracking");
  if (hd.triage === "auto_exclude") {
    await finish("skipped", { status: "excluded", fail_kind: "expired", reasons: [hd.reason, ...gaps.slice(0, 3)], draft: stored, ...triagePatch(hd, c, deps.now), ...due }, { excluded: 1 });
  } else {
    // 確認待ちになった理由を分類して、日別に集計する（主な確認待ち理由）
    const reasonCounts = Object.fromEntries(classifyReviewReasons([...gaps, hd.reason, ...decision.blockers]).map((k) => [k, 1]));
    await finish("review", { status: "pending", reasons: [...gaps, hd.reason].slice(0, 10), draft: { ...(stored as object), queued: { ...q, changed: false } } as unknown as Json, ...triagePatch(hd, c, deps.now), ...due }, { review_added: 1, reasons: reasonCounts });
  }
  return { usedAi: true, registered: false, aiFailed: false };
}

/** 収集元ごとの取得結果の記録。記録の失敗で本処理は止めないが、原因はログに残す */
async function recordAttempts(deps: CollectDeps, runId: string, reports: SourceReport[]): Promise<AttemptStatus[]> {
  const statuses: AttemptStatus[] = reports.map((r) => {
    if (r.status === "ok" || r.status === "blocked" || r.status === "needs_setup" || r.status === "disabled" || r.status === "not_configured") return r.status;
    // X API の月額予算に達している状態は、待っても変わらないので再試行しない
    return /予算/.test(r.message) ? "budget" : "error";
  });
  if (reports.length === 0) return statuses;
  const rows = reports.map((r, i) => ({ household_id: deps.householdId, run_id: runId, source_id: r.sourceId, trigger: deps.trigger, slot_date: deps.scheduled?.slotDate ?? null, status: statuses[i], items: r.items, new_count: r.newCount, message: r.message.slice(0, 300), detail: r.funnel ?? null }));
  const { error } = await deps.db.from("collection_source_attempts").insert(rows as never);
  if (error) console.error(`[collect] 収集元ごとの取得結果を記録できませんでした code=${error.code ?? "?"}`);
  return statuses;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((resolve) => (t = setTimeout(() => resolve(onTimeout()), ms)))]).finally(() => clearTimeout(t));
}

export async function runCollection(deps: CollectDeps): Promise<CollectOutcome> {
  const { db, householdId, now } = deps;
  const started = Date.now();
  const budgetMs = deps.budgetMs ?? 54_000;
  const timeLeft = () => budgetMs - (Date.now() - started);

  await ensureCollectionDefaults(db, householdId);
  // 異常終了した古い実行を閉じる(多重実行防止の「実行中」が残り続けないように)
  await db.from("collection_runs").update({ status: "failed", finished_at: new Date().toISOString() }).eq("household_id", householdId).eq("status", "running").lt("started_at", new Date(Date.now() - STALE_RUN_MS).toISOString());
  const ins = await db.from("collection_runs").insert({ household_id: householdId, trigger: deps.trigger, phase: "collect" }).select("id").single();
  if (ins.error || !ins.data) {
    return ins.error?.code === "23505" ? { ok: false, code: "already_running", message: "別の収集が実行中です。終わってからもう一度実行してください" } : { ok: false, code: "error", message: "収集を開始できませんでした" };
  }
  const runId = ins.data.id;

  const reports: SourceReport[] = [];
  const notices: string[] = [];
  let aiCalls = 0;
  let xCalls = 0;
  let xBilled = 0;
  let newCount = 0;
  let registered = 0;
  let errors = 0;
  let webFetched = 0;
  let screened = 0;
  let changed = 0;
  try {
    const [setRes, srcRes] = await Promise.all([
      db.from("collection_settings").select("*").eq("household_id", householdId).limit(1).maybeSingle(),
      db.from("collection_sources").select("*").eq("household_id", householdId).order("created_at"),
    ]);
    const settings = setRes.data;
    if (!settings) throw new Error("settings");
    const cond = conditionsFromRow(settings as unknown as Record<string, unknown>);
    let sources = ((srcRes.data ?? []) as unknown as SourceRow[]).filter((s) => s.enabled && (!deps.onlySourceIds || deps.onlySourceIds.includes(s.id)));
    // 定期収集は、スロットで未取得の収集元だけ（手動収集の last_attempt_at には左右されない）
    if (deps.scheduled) sources = sources.filter((s) => deps.scheduled!.sourceIds.includes(s.id));
    const data = await loadAppData(db, householdId);
    // AI読み取りは、1回の上限・月額予算（予約つき）・1時間の速度制限を守る。日次の件数上限はない
    const allow = await aiAllowance(deps, settings.max_ai_per_run);
    if (allow.note) notices.push(allow.note);
    const aiLeft = allow.allowed;

    const touch = async (s: SourceRow, patch: Record<string, unknown>) => {
      await db.from("collection_sources").update({ ...patch, last_attempt_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", s.id);
    };

    // ------------------------------------------------ 取得(キューへの追加)
    for (const s of sources) {
      if (timeLeft() < 8000) {
        notices.push(`時間の都合で「${s.name}」は次回に回しました`);
        continue;
      }
      if (s.kind === "web") {
        const res = await (deps.fetchList ?? ((u: string) => fetchRespectingRobots(u, { maxBytes: WEB_LIST_MAX_BYTES, timeoutMs: 15_000 })))(s.url!);
        if (!res.ok) {
          const blocked = res.code === "robots" || res.status === 403 || res.status === 429 || res.code === "blocked";
          const message = res.code === "robots" ? "サイトのrobots.txtにより取得が許可されていません" : blocked ? "サイト側のアクセス制限により取得できません（制限は回避しません）" : `取得に失敗しました: ${res.message}`;
          await touch(s, { status: blocked ? "blocked" : "error", error_message: message.slice(0, 500), last_item_count: 0, last_new_count: 0, last_result: "failed", consecutive_failures: s.consecutive_failures + 1 });
          reports.push({ sourceId: s.id, name: s.name, status: blocked ? "blocked" : "error", message, items: 0, newCount: 0 });
          errors++;
          continue;
        }
        webFetched++;
        const entries = parseListing((s.adapter === "pokeso" || s.adapter === "torecabiyori" ? s.adapter : "generic") as AdapterId, res.body, res.finalUrl);
        if (entries.length === 0) {
          const message = "一覧から告知リンクを取得できませんでした。サイトの構造が変わったか、このサイト用の解析設定が必要です";
          await touch(s, { status: "needs_setup", error_message: message, last_item_count: 0, last_new_count: 0, last_result: "failed", consecutive_failures: s.consecutive_failures + 1 });
          reports.push({ sourceId: s.id, name: s.name, status: "needs_setup", message, items: 0, newCount: 0 });
          errors++;
          continue;
        }
        const changedBefore = changed;
        const rows: Record<string, unknown>[] = [];
        const seenKeys: { key: string; hash: string; e: ListingEntry; hints: ListHints }[] = [];
        for (const e of entries as ListingEntry[]) {
          const rel = judgeRelevance(`${e.title} ${e.context}`, { fromPokemonList: true });
          if (!rel.relevant || (!looksLikeLottery(`${e.title} ${e.context}`) && e.kind !== "x_post" && rel.uncertain && !/chusen|lottery|entry|campaign|news|blog|event/i.test(e.url))) continue;
          const key = (e.kind === "x_post" ? `x:${/(\d{5,25})$/.exec(e.url)![1]}` : e.url).slice(0, 500);
          seenKeys.push({ key, hash: hashNormalized(`${e.title} ${e.context}`), e, hints: parseListHints(`${e.title} ${e.context}`, now) });
        }
        // 既に保存している候補は、内容の変化を確認する（広告・カウントダウンなどの変化は無視した正規化ハッシュで比べる）
        const existing = new Map<string, { id: string; list_hash: string | null; job_state: string; status: string; lottery_id: string | null; draft: Json | null; change_count: number; due_at: string | null }>();
        for (let i = 0; i < seenKeys.length; i += 100) {
          const { data: ex } = await db.from("collection_candidates").select("id,dedupe_key,list_hash,job_state,status,lottery_id,draft,change_count,due_at").eq("household_id", householdId).in("dedupe_key", seenKeys.slice(i, i + 100).map((x) => x.key));
          for (const r of ex ?? []) existing.set(r.dedupe_key, r);
        }
        const unchangedIds: string[] = [];
        for (const { key, hash, e, hints } of seenKeys) {
          const old = existing.get(key);
          if (old) {
            if (old.list_hash === hash) unchangedIds.push(old.id);
            else if (old.list_hash === null) {
              // 過去の版で保存した候補: 最初の確認では記録するだけ(変更とはみなさない)
              await db.from("collection_candidates").update({ list_hash: hash, last_checked_at: now.toISOString() }).eq("id", old.id);
            } else {
              changed++;
              const live = old.status === "auto_registered" || old.status === "duplicate" || old.job_state === "review";
              // 一覧の表記ゆれ（お気に入り・応募するなど）では再解析しない。応募締切が変わったときだけ、AIで再解析する
              const newDue = hints.deadlineIso ?? (hints.deadlineDate ? `${hints.deadlineDate}T23:59:00+09:00` : null);
              const reopen = (live && shouldReanalyzeOnListChange(old.due_at, newDue)) || (old.job_state === "skipped" && !preScreenFromList(hints, cond, now) && !(old.draft as { input?: unknown } | null)?.input);
              const patch: Record<string, unknown> = { list_hash: hash, content_hash: sha(`${e.title}|${e.context}`), last_checked_at: now.toISOString(), last_changed_at: now.toISOString(), change_count: old.change_count + 1, due_at: hints.deadlineIso ?? (hints.deadlineDate ? `${hints.deadlineDate}T23:59:00+09:00` : null) };
              if (reopen && old.job_state !== "pending" && old.job_state !== "processing") {
                const payload = { queued: { kind: e.kind === "x_post" ? "x_oembed" : "web_page", url: e.url, title: e.title, context: e.context, ...(e.card ? { card: e.card } : {}), ...(e.fields ? { fields: e.fields } : {}), sourceName: s.name, attempts: 0, hints, changed: true, reason: "list_change" as AiReason, listSeenAt: now.toISOString() } };
                Object.assign(patch, { job_state: "pending", status: old.job_state === "skipped" ? "pending" : old.status, kind: old.lottery_id ? "update" : "new", attempts: 0, next_run_at: null, reasons: ["内容の変更を検出しました（再解析待ち）"], draft: { ...((old.draft as object | null) ?? {}), ...payload } });
              }
              await db.from("collection_candidates").update(patch as never).eq("id", old.id);
            }
            continue;
          }
          const payload: QueuedPayload = { queued: { kind: e.kind === "x_post" ? "x_oembed" : "web_page", url: e.url, title: e.title, context: e.context, ...(e.card ? { card: e.card } : {}), ...(e.fields ? { fields: e.fields } : {}), sourceName: s.name, attempts: 0, hints, listSeenAt: now.toISOString() } };
          const dueAt = hints.deadlineIso ?? (hints.deadlineDate ? `${hints.deadlineDate}T23:59:00+09:00` : null);
          const base = { household_id: householdId, source_id: s.id, dedupe_key: key, source_url: e.url.slice(0, 500), title: safeSlice(e.title.length >= 10 ? e.title : safeSliceEnd(e.context, 80) || e.title || e.url, 200), content_hash: sha(`${e.title}|${e.context}`), list_hash: hash, due_at: dueAt, last_checked_at: now.toISOString(), discovered_run_id: runId };
          // 一覧の表示だけで除外できるもの(締切済み・対象外の地域)は、AI読み取りの前に除外する。候補としては保存し、次回以降は再判定しない
          const why = preScreenFromList(hints, cond, now);
          if (why) {
            rows.push({ ...base, status: "excluded", job_state: "skipped", reasons: [why], resolved_at: now.toISOString(), completed_at: now.toISOString(), draft: null });
            screened++;
          } else rows.push({ ...base, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: payload });
          if (rows.length >= MAX_NEW_PER_SOURCE * 3) break;
        }
        for (let i = 0; i < unchangedIds.length; i += 100) await db.from("collection_candidates").update({ last_checked_at: now.toISOString() }).in("id", unchangedIds.slice(i, i + 100));
        const saveRes = await saveCandidateRows(db, rows);
        const added = saveRes.saved;
        if (saveRes.failed > 0) {
          errors++;
          notices.push(`「${s.name}」: 候補の保存に失敗した項目が${saveRes.failed}件あります`);
        }
        newCount += added;
        // 新規発見は「候補を初めて保存した件数」。同じ候補を何度取得しても加算されない。初回の取り込みは通常の新着と区別する
        const initial = s.last_success_at === null;
        await bumpStats(db, householdId, now, { [initial ? "discovered_initial" : "discovered_new"]: added, excluded: rows.filter((r) => r.status === "excluded").length, changed: changed - changedBefore });
        await touch(s, { status: "ok", error_message: null, last_success_at: now.toISOString(), last_item_count: entries.length, last_new_count: added, last_result: added > 0 ? "new" : changed > changedBefore ? "changed" : "no_new", consecutive_failures: 0, ...(changed > changedBefore ? { last_changed_at: now.toISOString() } : {}) });
        reports.push({ sourceId: s.id, name: s.name, status: "ok", message: `リンク${entries.length}件を確認、新しい候補${added}件${changed > changedBefore ? `・内容の変更${changed - changedBefore}件` : ""}`, items: entries.length, newCount: added });
      } else {
        // ---- X(公式API)。設定・認証・予算がそろっていなければ1回も呼ばない
        if (!settings.x_enabled) {
          await touch(s, { status: "disabled", error_message: "X収集は無効です（設定で有効にするまで、X APIは呼びません）" });
          reports.push({ sourceId: s.id, name: s.name, status: "disabled", message: "X収集は無効です（API費用が発生するため、設定で有効にするまで実行しません）", items: 0, newCount: 0 });
          continue;
        }
        if (!deps.xClient) {
          await touch(s, { status: "not_configured", error_message: "X APIのキー（X_BEARER_TOKEN）が未設定です" });
          reports.push({ sourceId: s.id, name: s.name, status: "not_configured", message: "X APIのキー（X_BEARER_TOKEN）が未設定のため、実行していません", items: 0, newCount: 0 });
          continue;
        }
        const usedRes = await db.from("collection_runs").select("x_posts").eq("household_id", householdId).gte("started_at", jstMonthStart(now));
        const monthPosts = (usedRes.data ?? []).reduce((a, r) => a + r.x_posts, 0) + xBilled;
        const remain = remainingPosts({ monthPosts, budgetJpy: settings.x_monthly_budget_jpy });
        const want = Math.min(settings.x_max_posts_per_run, remain);
        if (settings.x_monthly_budget_jpy <= 0 || want < 5) {
          const message = settings.x_monthly_budget_jpy <= 0 ? "X API月額予算が0円のため実行していません" : "X APIの今月の予算上限に達したため停止しています";
          await touch(s, { status: "error", error_message: message });
          reports.push({ sourceId: s.id, name: s.name, status: "error", message, items: 0, newCount: 0 });
          errors++;
          continue;
        }
        let userId = s.x_user_id;
        if (!userId) {
          xCalls++;
          xBilled += 2; // ユーザー取得は投稿の約2倍の単価として数える(安全側)
          const u = await deps.xClient.lookupUser(s.x_username!);
          if (!u.ok) {
            await touch(s, { status: u.code === "not_configured" ? "not_configured" : "error", error_message: u.message });
            reports.push({ sourceId: s.id, name: s.name, status: "error", message: u.message, items: 0, newCount: 0 });
            errors++;
            continue;
          }
          userId = u.id;
          await db.from("collection_sources").update({ x_user_id: u.id }).eq("id", s.id);
        }
        xCalls++;
        const r = await deps.xClient.userPosts(userId, s.x_username!, { sinceId: s.x_since_id, max: want, startTime: new Date(now.getTime() - X_FIRST_FETCH_DAYS * 86_400_000).toISOString() });
        if (!r.ok) {
          await touch(s, { status: "error", error_message: r.message });
          reports.push({ sourceId: s.id, name: s.name, status: "error", message: r.message, items: 0, newCount: 0 });
          errors++;
          if (r.code === "credits_depleted" || r.code === "unauthorized" || r.code === "rate_limited") notices.push(r.message);
          continue;
        }
        // 引用元の投稿も読み取りの対象になるため、課金の見積りに数える
        xBilled += r.posts.length + (r.posts as XPost[]).filter((p) => p.quoted).length;
        // 各段階で何件が次へ進んだかを数える（取得できた＝成功、とは扱わない）
        const funnel = emptyFunnel();
        funnel.fetched = r.posts.length;
        const rows: Record<string, unknown>[] = [];
        for (const p of r.posts as XPost[]) {
          if (p.images.length > 0 || (p.quoted?.images.length ?? 0) > 0) funnel.withImages++;
          if (p.quoted) funnel.withQuote++;
          if (p.links.length > 0) funnel.withLinks++;
          // 本文のキーワードだけで画像・引用つきの投稿を落とさない（Stage 6B）。他のTCG・無関係な長文・古い投稿だけ解析しない
          const j = judgeXPost({ text: p.text, images: p.images, links: p.links, createdAt: p.createdAt, quoted: p.quoted ?? null }, now);
          if (!j.pass) {
            funnel.skipped[j.skip]++;
            continue;
          }
          funnel.passed[j.basis]++;
          const payload: QueuedPayload = { queued: { kind: "x_post", url: p.url, title: safeSlice(p.text, 80), context: "", sourceName: s.name, attempts: 0, listSeenAt: now.toISOString(), post: { id: p.id, text: p.text, images: p.images, links: p.links, createdAt: p.createdAt, username: p.username ?? s.x_username ?? "", ...(p.authorId ? { authorId: p.authorId } : {}), ...(p.profile ? { profile: p.profile } : {}), ...(p.quoted ? { quoted: p.quoted } : {}) }, relevanceBasis: j.basis } };
          rows.push({ household_id: householdId, source_id: s.id, dedupe_key: `x:${p.id}`, source_url: p.url, x_post_id: p.id, title: safeSlice(p.text.replace(/\n/g, " "), 80) || p.url, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: payload, last_checked_at: now.toISOString(), discovered_run_id: runId });
        }
        const saveRes = await saveCandidateRows(db, rows);
        funnel.saved = saveRes.saved;
        funnel.saveFailed = saveRes.failed;
        funnel.existing = rows.length - saveRes.saved - saveRes.failed;
        const added = saveRes.saved;
        newCount += added;
        await bumpStats(db, householdId, now, { [s.last_success_at === null ? "discovered_initial" : "discovered_new"]: added });
        // 保存できなかった投稿があるときは失敗として記録する（取得した件数だけで成功にしない）
        const summaryLine = funnelLine(funnel);
        const failedSave = saveRes.failed > 0;
        if (failedSave) {
          errors++;
          notices.push(`「${s.name}」: 候補の保存に失敗した投稿が${saveRes.failed}件あります`);
        }
        await touch(s, { status: failedSave ? "error" : "ok", error_message: failedSave ? `候補の保存に失敗した投稿があります（${saveRes.failed}件）` : null, ...(failedSave ? {} : { last_success_at: now.toISOString() }), last_item_count: r.posts.length, last_new_count: added, ...(r.newestId ? { x_since_id: r.newestId } : {}) });
        reports.push({ sourceId: s.id, name: s.name, status: failedSave ? "error" : "ok", message: summaryLine, items: r.posts.length, newCount: added, funnel });
      }
    }

    // 収集元ごとの取得結果を記録する（Cron が起動したことと、実際に取得できたことを区別する）
    const attemptStatuses = await recordAttempts(deps, runId, reports);
    const itemsFound = reports.reduce((a, r) => a + r.items, 0);

    // ------------------------------------------------ 解析(キュー): 手動実行でも、定期ワーカーと同じ処理(原子的な取得・優先順位・再試行)を使う
    // 優先収集メモの照合（既存の抽選・候補・参考URL）。該当する解析待ちを先に処理できるよう、キューの処理の前に行う
    await runMemoPass(deps, { data }).catch(() => undefined);
    const q = await processQueue(deps, { settings, cond, data, aiLeft, timeLeft, perBatch: AI_CONCURRENCY });
    aiCalls += q.aiCalls;
    registered += q.registered;
    screened += q.screened;
    const leftover = q.queued;
    if (q.stopReason) notices.push(q.stopReason);
    if (screened > 0) notices.push(`一覧の表示から${screened}件を、AI読み取りの前に除外しました（締切済み・対象外の地域）`);
    if (leftover > 0) notices.push(`解析待ちが${leftover}件残っています（1回のAI読み取りの上限・時間の都合。締切が近いものから順に、バックグラウンドのワーカーが続きを解析します）`);
    if (newCount > MASS_NEW_WARN) notices.push(`新しい候補が${newCount}件と多く発生しました。収集元の変化を確認してください`);

    const pendingRes = await db.from("collection_candidates").select("id", { count: "exact", head: true }).eq("household_id", householdId).in("job_state", ["pending", "retry", "processing"]);
    await db
      .from("collection_runs")
      .update({ status: "done", finished_at: new Date().toISOString(), slot_date: deps.scheduled?.slotDate ?? null, result: runResultOf(attemptStatuses), sources_total: reports.length, sources_ok: attemptStatuses.filter((s) => s === "ok").length, sources_failed: attemptStatuses.filter((s) => !["ok", "disabled", "not_configured", "budget"].includes(s)).length, items_found: itemsFound, web_fetched: webFetched, x_posts: xBilled, x_calls: xCalls, ai_calls: aiCalls, new_count: newCount, registered_count: registered, error_count: errors, processed_count: q.processed, changed_count: changed, skipped_count: screened + q.skipped, stop_reason: q.stopReason?.slice(0, 120) ?? null, summary: reports as unknown as Json })
      .eq("id", runId);
    return { ok: true, runId, aiCalls, xCalls, xPosts: xBilled, newCount, screened, queued: leftover, registered, errors, pending: pendingRes.count ?? 0, sources: reports, notices };
  } catch {
    // 定期収集で取得結果が記録される前に失敗した収集元は、失敗として記録する（記録が無いままだと数分おきに再実行され続けるため）
    if (deps.scheduled) {
      const done = new Set(reports.map((r) => r.sourceId));
      const missing: SourceReport[] = deps.scheduled.sourceIds.filter((id) => !done.has(id)).map((id) => ({ sourceId: id, name: "", status: "error", message: "収集処理でエラーが発生しました", items: 0, newCount: 0 }));
      await recordAttempts(deps, runId, missing).catch(() => undefined);
    }
    await db.from("collection_runs").update({ status: "failed", finished_at: new Date().toISOString(), slot_date: deps.scheduled?.slotDate ?? null, result: "failed", error_count: errors + 1, summary: reports as unknown as Json }).eq("id", runId);
    return { ok: false, code: "error", message: "収集中にエラーが発生しました" };
  }
}

export interface QueueCtx {
  settings: { auto_register: boolean; consecutive_failures?: number };
  cond: CollectionConditions;
  data: AppData;
  aiLeft: number;
  timeLeft: () => number;
  perBatch: number;
}
interface QueueResult {
  aiCalls: number;
  registered: number;
  screened: number;
  skipped: number;
  processed: number;
  queued: number;
  stopReason: string | null;
}

/**
 * 解析待ち全体の事前整理(費用なし): 一覧の表示から、締切済み・対象外の地域のものを、AI読み取りの前に除外する。
 * 過去に溜まった解析待ちも対象。除外した候補は削除せず、理由を付けて残す(「確認待ちに戻す」で解析できる)。
 */
export async function triageQueue(deps: CollectDeps, cond: CollectionConditions): Promise<number> {
  const { db, householdId, now } = deps;
  const { data } = await db.from("collection_candidates").select("id,draft,kind").eq("household_id", householdId).eq("job_state", "pending").limit(2000);
  let n = 0;
  const jobs: PromiseLike<unknown>[] = [];
  for (const c of data ?? []) {
    const q = (c.draft as unknown as Partial<QueuedPayload> | null)?.queued;
    if (!q || q.kind === "x_post" || q.changed) continue;
    const why = preScreenFromList(q.hints ?? parseListHints(`${q.title} ${q.context}`, now), cond, now);
    if (!why) continue;
    n++;
    jobs.push(db.from("collection_candidates").update({ status: "excluded", job_state: "skipped", reasons: [why], draft: null, resolved_at: now.toISOString(), completed_at: now.toISOString() }).eq("id", c.id).eq("job_state", "pending").then(() => undefined));
  }
  for (let i = 0; i < jobs.length; i += 25) await Promise.all(jobs.slice(i, i + 25));
  return n;
}

const AI_PAUSE_AFTER = 5;
const AI_PAUSE_MS = 6 * 3600_000;

/**
 * ジョブキューを処理する(手動実行・定期ワーカー共通)。
 *  - claim_collection_jobs で優先順位順に原子的に取得(複数のワーカーが同時に動いても同じジョブを取らない。異常終了したワーカーのジョブはリース切れで再取得)
 *  - 解析前の絞り込み(締切済み・対象外の地域)は費用なしで先に行う
 *  - 取得とAI読み取りは並行、判定と登録は1件ずつ。時間・上限が近づいたら新しい処理を始めず、残りは次回のワーカーが引き継ぐ
 *  - AI読み取りが連続で失敗したら、一定時間自動停止する
 */
export async function processQueue(deps: CollectDeps, ctx: QueueCtx): Promise<QueueResult> {
  const { db, householdId, now } = deps;
  const out: QueueResult = { aiCalls: 0, registered: 0, screened: 0, skipped: 0, processed: 0, queued: 0, stopReason: null };
  let aiLeft = ctx.aiLeft;
  let data = ctx.data;
  const workerId = `w-${Math.random().toString(36).slice(2, 10)}`;
  let fails = ctx.settings.consecutive_failures ?? 0;
  const lease = 150;
  const rules = await activeExclusions(db, householdId);
  const userRules = await activeUserRules(db, householdId);
  deps.xLinks ??= await loadXLinks(db, householdId).catch(() => new Map<string, XLink>());
  deps.xIdentities ??= await loadXIdentities(db, householdId).catch(() => new Map<string, SavedIdentity>());
  let budgetHit = false;
  const triaged = await triageQueue(deps, ctx.cond);
  out.screened += triaged;
  await bumpStats(db, householdId, now, { excluded: triaged });

  while (ctx.timeLeft() >= 20_000) {
    const want = Math.min(ctx.perBatch, Math.max(aiLeft, 0) + 8); // 解析前に除外されるものは費用がかからないので、少し多めに取得する
    const claimed = await db.rpc("claim_collection_jobs", { p_household: householdId, p_limit: want, p_worker: workerId, p_lease_seconds: lease, p_now: now.toISOString() });
    // RETURNING の順序は保証されないので、優先順位の高い順に並べ直す(DBの計算と同じ priorityScore)
    const jobs = ((claimed.data ?? []) as unknown as (CandidateRow & { due_at: string | null; next_run_at: string | null; last_changed_at: string | null })[])
      .map((c) => ({ c, score: priorityScore({ now, dueAt: c.due_at ? new Date(c.due_at) : null, createdAt: new Date(c.created_at), nextRunAt: c.next_run_at ? new Date(c.next_run_at) : null, changed: c.kind === "update" || (c.last_changed_at ? now.getTime() - new Date(c.last_changed_at).getTime() < 2 * 86400_000 : false), bookmark: (c.draft as { queued?: { bookmark?: boolean } } | null)?.queued?.bookmark === true }) }))
      .sort((x, y) => y.score - x.score || (x.c.due_at ?? "9").localeCompare(y.c.due_at ?? "9"))
      .map((x) => x.c as CandidateRow);
    if (jobs.length === 0) break;

    const toAnalyze: { c: CandidateRow; q: QueuedPayload["queued"] }[] = [];
    const release: string[] = [];
    for (const c of jobs) {
      const q = (c.draft as unknown as Partial<QueuedPayload> | null)?.queued;
      if (!q) {
        await db.from("collection_candidates").update({ status: "failed", job_state: "failed", last_error: "ジョブの内容がありません", lease_until: null, locked_by: null, completed_at: now.toISOString() }).eq("id", c.id);
        continue;
      }
      // 収集元の除外ルール（利用者が指定したXアカウント・個別サイト）に一致したら、AIを呼ばずに除外する
      const exRule = matchExclusion(rules, { url: q.kind === "x_post" ? null : q.url, xUsername: q.kind === "x_post" ? q.sourceName : null });
      if (exRule) {
        await db.from("collection_candidates").update({ status: "excluded", job_state: "skipped", triage: "auto_exclude", triage_reason: "収集元の除外ルールに一致", reasons: [`収集元の除外ルール（${exRule.label || exRule.scope}）に一致したため除外しました`], resolved_at: now.toISOString(), completed_at: now.toISOString(), lease_until: null, locked_by: null }).eq("id", c.id);
        out.screened++;
        await bumpStats(db, householdId, now, { excluded: 1 });
        continue;
      }
      const hints = q.hints ?? parseListHints(`${q.title} ${q.context}`, now);
      const why = q.kind === "x_post" || q.changed ? null : preScreenFromList(hints, ctx.cond, now);
      if (why) {
        await db.from("collection_candidates").update({ status: "excluded", job_state: "skipped", reasons: [why], draft: null, resolved_at: now.toISOString(), completed_at: now.toISOString(), lease_until: null, locked_by: null }).eq("id", c.id);
        out.screened++;
        await bumpStats(db, householdId, now, { excluded: 1 });
        continue;
      }
      if (aiLeft <= 0) {
        release.push(c.id);
        continue;
      }
      aiLeft--;
      toAnalyze.push({ c, q: { ...q, hints } });
    }
    // 上限に達して今回は解析しないジョブは、試行回数を戻して待機に戻す(次のワーカーが優先順位順に取得する)
    for (const id of release) await db.from("collection_candidates").update({ job_state: "pending", lease_until: null, locked_by: null, attempts: 0 }).eq("id", id);
    if (toAnalyze.length === 0) {
      if (aiLeft <= 0) break;
      continue;
    }

    // 実行時間の上限(60秒)を超えて実行が打ち切られないよう、バッチごとに残り時間で打ち切る
    const limit = Math.max(5_000, ctx.timeLeft() - 6_000);
    const timedOut = (): ExtractResult => ({ ok: false, kind: "url", code: "ai_failed", message: "時間切れのため解析できませんでした" });
    // 月額予算の予約: 実際の呼び出しの直前に、並列実行を含めて予算内かを確認する。取れなかった候補は解析せず、待機に戻す
    const snap = await budgetSnapshot(deps);
    const denied = new Set<string>();
    const results = await Promise.all(
      toAnalyze.map(async (it): Promise<ExtractResult> => {
        const rv = await reserveBudget(deps, snap);
        if (!rv.ok) {
          denied.add(it.c.id);
          return { ok: false, kind: "url", code: "ai_failed", message: "予算" };
        }
        try {
          return await withTimeout(extractFor(deps, it.q).catch((): ExtractResult => ({ ok: false, kind: "url", code: "ai_failed", message: "解析中にエラーが発生しました" })), limit, timedOut);
        } finally {
          await rv.release();
        }
      }),
    );
    let batchAiFail = 0;
    for (let i = 0; i < toAnalyze.length; i++) {
      const it = toAnalyze[i];
      if (denied.has(it.c.id)) {
        // 予算不足で解析していない: 処理済み扱いにせず（除外もせず）、試行回数を戻して待機に残す
        budgetHit = true;
        await db.from("collection_candidates").update({ job_state: it.c.triage === "auto_retry" ? "retry" : "pending", lease_until: null, locked_by: null, attempts: Math.max(0, (it.c.attempts ?? 1) - 1) }).eq("id", it.c.id);
        continue;
      }
      const r = await processCandidate(deps, data, ctx.cond, ctx.settings.auto_register, it.c, it.q, results[i], rules, userRules).catch(async (): Promise<Outcome> => {
        await db.from("collection_candidates").update({ status: "pending", job_state: "retry", last_error: "解析中にエラーが発生しました", next_run_at: new Date(now.getTime() + 15 * 60_000).toISOString(), lease_until: null, locked_by: null }).eq("id", it.c.id);
        return { usedAi: true, registered: false, aiFailed: true };
      });
      out.processed++;
      if (r.usedAi) out.aiCalls++;
      if (r.aiFailed) batchAiFail++;
      if (r.registered) {
        out.registered++;
        // 登録した抽選を、以降の重複検出に反映する(同じ回の中で同じ抽選を二重に登録しない)
        data = await loadAppData(db, householdId);
      }
    }
    // 連続失敗の自動停止: バッチ全体がAI側の失敗なら加算、1件でも成功したらリセット
    fails = batchAiFail === toAnalyze.length ? fails + batchAiFail : 0;
    if (fails >= AI_PAUSE_AFTER) {
      const until = new Date(Date.now() + AI_PAUSE_MS).toISOString();
      await db.from("collection_settings").update({ consecutive_failures: fails, paused_until: until, paused_reason: "AI読み取りが連続で失敗したため、6時間停止します" }).eq("household_id", householdId);
      out.stopReason = "AI読み取りが連続で失敗したため、自動処理を一時停止しました";
      break;
    }
    if (budgetHit) {
      out.stopReason = "今月のAI予算に達したため停止しています";
      break;
    }
    if (aiLeft <= 0) break;
  }
  if (!out.stopReason) await db.from("collection_settings").update({ consecutive_failures: fails }).eq("household_id", householdId);
  const left = await db.from("collection_candidates").select("id", { count: "exact", head: true }).eq("household_id", householdId).in("job_state", ["pending", "retry", "processing"]);
  out.queued = left.count ?? 0;
  await bumpStats(db, householdId, now, { queue_remaining: out.queued });
  if (aiLeft <= 0 && out.queued > 0 && !out.stopReason) out.stopReason = null;
  return out;
}

/** 告知ページの本文が変わっていないか確認する(AIは使わない)。変わっていれば再解析を、中止の表現があれば更新の提案を作る */
export async function recheckPages(deps: CollectDeps, opts: { max: number; recheckHours: number; timeLeft: () => number }): Promise<{ checked: number; changed: number }> {
  const { db, householdId, now } = deps;
  const before = new Date(now.getTime() - opts.recheckHours * 3600_000).toISOString();
  const { data } = await db
    .from("collection_candidates")
    .select("id,dedupe_key,source_url,draft,status,lottery_id,page_hash,due_at,job_state,last_checked_at")
    .eq("household_id", householdId)
    .in("job_state", ["completed", "review"])
    .in("status", ["auto_registered", "pending", "duplicate"])
    .or(`last_checked_at.is.null,last_checked_at.lt.${before}`)
    .or(`due_at.is.null,due_at.gt.${now.toISOString()}`)
    .not("source_url", "is", null)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(opts.max * 3);
  let checked = 0;
  let changed = 0;
  for (const c of data ?? []) {
    if (checked >= opts.max || opts.timeLeft() < 10_000) break;
    if (c.dedupe_key.startsWith("x:") || !c.source_url) continue;
    const pg = await (deps.fetchPage ?? ((u: string) => fetchRespectingRobots(u)))(c.source_url);
    checked++;
    if (!pg.ok) {
      await db.from("collection_candidates").update({ last_checked_at: now.toISOString() }).eq("id", c.id);
      continue;
    }
    const text = extractPageText(pg.body, pg.finalUrl).text;
    if (text.length < 30) {
      await db.from("collection_candidates").update({ last_checked_at: now.toISOString() }).eq("id", c.id);
      continue;
    }
    const hash = hashNormalized(text);
    const patch: Record<string, unknown> = { last_checked_at: now.toISOString(), page_hash: hash };
    if (c.page_hash && c.page_hash !== hash) {
      changed++;
      const prevDraft = (c.draft as object | null) ?? {};
      const cancel = c.lottery_id ? detectCancel(text) : null;
      if (cancel && c.lottery_id) {
        // 中止の表示: 状態の更新を提案する(確定情報は自動では書き換えない)
        const base = (await db.from("lotteries").select("updated_at,event_state").eq("id", c.lottery_id).maybeSingle()).data;
        if (base && base.event_state !== "cancelled") {
          Object.assign(patch, { job_state: "review", kind: "update", status: "pending", last_changed_at: now.toISOString(), reasons: [`状態: 受付中 → 中止（告知に「${cancel}」）`], draft: { ...prevDraft, update: { changes: [{ key: "eventState", label: "状態", before: "受付中", after: "中止" }], baseUpdatedAt: base.updated_at } } });
        }
      } else {
        // 取得済みの一覧の情報（カード・店舗/商品・ヒント）は引き継ぐ。本文の更新は一覧の情報を上書きしない
        const q = rebuildQueued(prevDraft, { kind: "web_page", url: c.source_url, sourceName: "再確認", reason: "page_update", changed: true });
        Object.assign(patch, { job_state: "pending", kind: c.lottery_id ? "update" : "new", status: c.status === "auto_registered" || c.status === "duplicate" ? c.status : "pending", attempts: 0, next_run_at: null, last_changed_at: now.toISOString(), reasons: ["告知ページの内容の変更を検出しました（再解析待ち）"], draft: { ...prevDraft, queued: q } });
      }
    }
    await db.from("collection_candidates").update(patch as never).eq("id", c.id);
  }
  return { checked, changed };
}

export type WorkerOutcome =
  | { ok: true; skipped: string }
  | { ok: true; runId: string; aiCalls: number; processed: number; screened: number; registered: number; queued: number; rechecked: number; changed: number; stopReason: string | null }
  | { ok: false; message: string };


/**
 * 定期ワーカー(Supabase Cronが数分おきに起動)の1回分。解析待ちがなければ何もせず、すぐ終了する。
 * 費用の上限: ワーカーの1日の上限・既存のAI利用上限(時間/日/月額予算)・連続失敗での停止。上限に達したら次のAIリクエストを開始しない。
 */
export async function runWorker(deps: CollectDeps): Promise<WorkerOutcome> {
  const { db, householdId, now } = deps;
  const started = Date.now();
  const timeLeft = () => (deps.budgetMs ?? 54_000) - (Date.now() - started);
  const { data: settings } = await db.from("collection_settings").select("*").eq("household_id", householdId).limit(1).maybeSingle();
  if (!settings) return { ok: true, skipped: "no_settings" };
  if (!settings.worker_enabled) return { ok: true, skipped: "worker_disabled" };
  if (settings.paused_until && new Date(settings.paused_until).getTime() > Date.now()) return { ok: true, skipped: "paused" };
  if (settings.paused_until) await db.from("collection_settings").update({ paused_until: null, paused_reason: null, consecutive_failures: 0 }).eq("household_id", householdId);

  // 月額予算に達している間は、実行記録を毎回は増やさない(最初の1回だけ記録する)
  const budgetStop = await db.from("collection_runs").select("stop_reason,started_at").eq("household_id", householdId).eq("phase", "worker").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (budgetStop.data?.stop_reason?.startsWith("今月のAI予算") && budgetStop.data.started_at >= jstMonthStart(now)) {
    const snap = await budgetSnapshot(deps);
    if (snap && snap.costJpy + snap.estimateJpy > snap.budgetJpy) return { ok: true, skipped: "budget" };
  }
  const ready = await db.from("collection_candidates").select("id", { count: "exact", head: true }).eq("household_id", householdId).or(`and(job_state.in.(pending,retry),or(next_run_at.is.null,next_run_at.lte.${new Date().toISOString()})),and(job_state.eq.processing,lease_until.lt.${new Date().toISOString()})`);
  const hasWork = (ready.count ?? 0) > 0;
  const recheckDue = await db.from("collection_candidates").select("id", { count: "exact", head: true }).eq("household_id", householdId).in("job_state", ["completed", "review"]).in("status", ["auto_registered", "pending", "duplicate"]).or(`last_checked_at.is.null,last_checked_at.lt.${new Date(now.getTime() - settings.recheck_hours * 3600_000).toISOString()}`).not("source_url", "is", null).limit(1);
  if (!hasWork && (recheckDue.count ?? 0) === 0) return { ok: true, skipped: "idle" };

  await db.from("collection_runs").update({ status: "failed", finished_at: new Date().toISOString(), stop_reason: "タイムアウト" }).eq("household_id", householdId).eq("status", "running").lt("started_at", new Date(Date.now() - STALE_RUN_MS).toISOString());
  const ins = await db.from("collection_runs").insert({ household_id: householdId, trigger: "cron", phase: "worker" }).select("id").single();
  if (ins.error || !ins.data) return { ok: true, skipped: "busy" };
  const runId = ins.data.id;
  try {
    const cond = conditionsFromRow(settings as unknown as Record<string, unknown>);
    const data = await loadAppData(db, householdId);
    // 月額予算（予約つき）と1時間の速度制限。日次の件数上限はない
    const allow = await aiAllowance(deps, settings.worker_batch);
    let stopReason: string | null = allow.stop === "budget" ? "今月のAI予算に達したため停止しています" : allow.note || null;
    await runMemoPass(deps, { data }).catch(() => undefined);
    const q = await processQueue(deps, { settings, cond, data, aiLeft: allow.allowed, timeLeft, perBatch: AI_CONCURRENCY });
    stopReason = q.stopReason ?? stopReason;
    const rc = timeLeft() > 12_000 ? await recheckPages(deps, { max: 8, recheckHours: settings.recheck_hours, timeLeft }) : { checked: 0, changed: 0 };
    await db
      .from("collection_runs")
      .update({ status: "done", finished_at: new Date().toISOString(), ai_calls: q.aiCalls, registered_count: q.registered, processed_count: q.processed, changed_count: rc.changed, skipped_count: q.screened + q.skipped, stop_reason: stopReason?.slice(0, 120) ?? null, summary: [] as unknown as Json })
      .eq("id", runId);
    return { ok: true, runId, aiCalls: q.aiCalls, processed: q.processed, screened: q.screened, registered: q.registered, queued: q.queued, rechecked: rc.checked, changed: rc.changed, stopReason };
  } catch {
    await db.from("collection_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_count: 1, stop_reason: "エラー" }).eq("id", runId);
    return { ok: false, message: "ワーカーの実行中にエラーが発生しました" };
  }
}

const UPDATE_KEYS: Record<string, string[]> = {
  applyStart: ["apply_start_precision", "apply_start_date", "apply_start_at"],
  applyDeadline: ["apply_deadline_precision", "apply_deadline_date", "apply_deadline_at"],
  resultDate: ["result_precision", "result_date", "result_at"],
  procedureStart: ["procedure_start_precision", "procedure_start_date", "procedure_start_at"],
  procedureDeadline: ["procedure_deadline_precision", "procedure_deadline_date", "procedure_deadline_at"],
  receiveMethod: ["receive_method"],
  eventState: ["event_state"],
};

/**
 * 既存の抽選への更新提案を反映する(利用者のログインで実行)。反映するのは日時・受取方法・状態だけ。
 * 応募・当落・スルー・購入には触れない。提案を作った後に利用者が抽選を編集していた場合(更新日時が変わっている)は反映せず、手動で確認してもらう。
 */
export async function applyCandidateUpdate(db: Db, candidateId: string): Promise<{ ok: true; applied: number } | { ok: false; message: string }> {
  const { data: c } = await db.from("collection_candidates").select("id,draft,lottery_id,kind").eq("id", candidateId).maybeSingle();
  const upd = (c?.draft as unknown as { update?: { changes: FieldChange[]; baseUpdatedAt: string | null; input?: LotteryInput } } | null)?.update;
  if (!c || !c.lottery_id || !upd) return { ok: false, message: "反映できる更新がありません" };
  const { data: lot } = await db.from("lotteries").select("id,updated_at").eq("id", c.lottery_id).maybeSingle();
  if (!lot) return { ok: false, message: "抽選が見つかりません" };
  if (upd.baseUpdatedAt && lot.updated_at !== upd.baseUpdatedAt) {
    return { ok: false, message: "提案のあとに抽選が編集されているため、自動では反映しません。内容を確認して手動で修正してください" };
  }
  const patch: Record<string, unknown> = {};
  const row = upd.input ? lotteryRow(upd.input as never, null) : null;
  for (const ch of upd.changes) {
    if (ch.key === ("eventState" as never)) {
      patch.event_state = "cancelled";
      continue;
    }
    if (!row) continue;
    for (const col of UPDATE_KEYS[ch.key] ?? []) patch[col] = (row as unknown as Record<string, unknown>)[col];
  }
  if (Object.keys(patch).length === 0) return { ok: false, message: "反映できる項目がありません" };
  const { error } = await db.from("lotteries").update(patch as never).eq("id", lot.id).eq("updated_at", lot.updated_at);
  if (error) return { ok: false, message: "反映に失敗しました" };
  const after = (await db.from("lotteries").select("updated_at").eq("id", lot.id).maybeSingle()).data?.updated_at ?? null;
  const hh = (await db.from("collection_candidates").select("household_id").eq("id", candidateId).maybeSingle()).data?.household_id;
  if (hh) await bumpStats(db, hh, new Date(), { updated_existing: 1 });
  await db
    .from("collection_candidates")
    .update({ job_state: "completed", kind: "new", status: "auto_registered", reasons: ["更新の提案を反映しました"], resolved_at: new Date().toISOString(), draft: { ...(c.draft as object), update: null, lotteryUpdatedAt: after } as unknown as Json })
    .eq("id", candidateId);
  return { ok: true, applied: Object.keys(patch).length };
}

/** 確認待ちの候補を登録する(利用者のログインで実行)。要チェックにせず、応募記録は作らない。入力は画面で修正された内容を使える */
export async function registerCandidate(db: Db, householdId: string, actor: string | null, candidateId: string, override?: LotteryInput): Promise<{ ok: true; lotteryId: string } | { ok: false; message: string }> {
  const { data: c } = await db.from("collection_candidates").select("id,draft,status,source_url").eq("id", candidateId).maybeSingle();
  if (!c) return { ok: false, message: "候補が見つかりません" };
  if (c.status === "auto_registered") return { ok: false, message: "登録済みです" };
  const input = override ?? ((c.draft as unknown as { input?: LotteryInput } | null)?.input ?? null);
  if (!input) return { ok: false, message: "登録できる内容がありません（解析前の候補です）" };
  const saved = await saveLottery(db, householdId, null, { ...input, isManaged: false, applications: [] }, actor);
  if (!saved.ok) return { ok: false, message: saved.error };
  await db.from("lotteries").update({ source_kind: "auto", is_new: true, registration_path: "auto_confirmed", confirmed_at: new Date().toISOString(), confirmed_by_profile_id: actor }).eq("id", saved.value.id);
  await bumpStats(db, householdId, new Date(), { registered_new: 1 });
  await db.from("collection_candidates").update({ status: "auto_registered", job_state: "completed", lottery_id: saved.value.id, reasons: ["確認のうえ登録しました"], manual_state: "resolved", manual_resolved_at: new Date().toISOString(), manual_resolved_by: actor, resolved_at: new Date().toISOString(), completed_at: new Date().toISOString() }).eq("id", candidateId);
  return { ok: true, lotteryId: saved.value.id };
}

export const hashText = sha;
export const normalizeEntryUrl = normalizeUrl;
export { X_COST_PER_POST_JPY };
