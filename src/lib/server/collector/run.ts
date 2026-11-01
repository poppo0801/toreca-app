import "server-only";
import { createHash } from "node:crypto";
import { normalizeConditions, evaluateCandidate, type CollectionConditions } from "@/lib/collector/conditions";
import { judgeRelevance, normalizeUrl, parseListing, looksLikeLottery, type AdapterId, type ListingEntry } from "@/lib/collector/listing";
import { remainingPosts, X_COST_PER_POST_JPY, type XPost } from "@/lib/collector/x-posts";
import { extractPageText } from "@/lib/ai/page-text";
import { PROMPT_VERSION, type ExtractRequest, type LotteryExtractor } from "@/lib/ai/provider";
import { buildDraft, type LotteryDraft } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";
import { storeDistance } from "@/lib/store-distance";
import { extractFromRequest, runExtraction, MAX_IMAGES, type ExtractResult } from "@/lib/server/lottery-extract-service";
import { monthBudget } from "@/lib/server/ai-budget";
import { loadAppData, saveLottery, type Db } from "@/lib/server/lottery-service";
import { splitTallImages } from "@/lib/server/image-split";
import { fetchXPost } from "@/lib/server/x-source";
import { fetchRespectingRobots, type SafeFetchResult } from "@/lib/server/safe-fetch";
import { fetchXImage, type XClient } from "@/lib/server/collector/x-client";
import type { Json } from "@/types/database";
import type { AppData } from "@/types/domain";

/**
 * 抽選情報の自動収集（Stage 4C）。
 *   収集元 → 告知リンク/X投稿 → 関連判定(ルール) → AI読み取り(既存の共通処理) → 収集条件 → マスター照合 → 重複検出 → 候補/自動登録
 * - 自動収集は★管理対象にしない・応募記録を作らない・既存抽選の確定情報を書き換えない（重複時は情報源URLの追加のみ）
 * - 登録は利用者のログイン(auth.uid)が必要なため、定期実行(service_role)は候補の作成まで。登録は手動実行か候補画面で行う
 * - AI・X APIは上限(1回あたり/月額予算/既存のAI利用上限)の範囲内でのみ呼ぶ。上限を超える分は次回に回す(キュー)
 */

export const WEB_LIST_MAX_BYTES = 4_500_000;
const MAX_NEW_PER_SOURCE = 60;
const STALE_RUN_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;

export interface CollectDeps {
  db: Db;
  householdId: string;
  trigger: "manual" | "cron";
  now: Date;
  /** 登録先のプロフィール(更新者)。cron では null */
  actor: string | null;
  /** 利用者のログインで実行している（抽選の自動登録ができる） */
  canRegister: boolean;
  extractor: LotteryExtractor | null;
  fetchList?: (url: string) => Promise<SafeFetchResult>;
  fetchPage?: (url: string) => Promise<SafeFetchResult>;
  fetchOembed?: typeof fetchXPost;
  xClient: XClient | null;
  fetchImage?: typeof fetchXImage;
  budgetMs?: number;
  /** 指定した収集元だけ実行する */
  onlySourceIds?: string[];
}

export interface SourceReport {
  sourceId: string;
  name: string;
  status: string;
  message: string;
  items: number;
  newCount: number;
}

export type CollectOutcome =
  | {
      ok: true;
      runId: string;
      aiCalls: number;
      xCalls: number;
      xPosts: number;
      newCount: number;
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
  x_since_id: string | null;
};

interface QueuedPayload {
  queued: {
    kind: "web_page" | "x_oembed" | "x_post";
    url: string;
    title: string;
    context: string;
    sourceName: string;
    post?: { id: string; text: string; images: string[]; links: string[]; createdAt: string };
    attempts: number;
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
  });
}

/** AI読み取りの利用記録（既存の費用管理と同じテーブル）。入力した本文・画像そのものは保存しない */
async function logAi(deps: CollectDeps, result: ExtractResult, sourceUrl: string): Promise<void> {
  const status = result.ok ? (result.extraction.applyDeadline.precision === "unknown" || result.extraction.items.length === 0 ? "partial" : "ok") : result.code === "rate_limited" ? "rate_limited" : result.code === "fetch_failed" ? "fetch_failed" : "failed";
  await deps.db.from("ai_extraction_logs").insert({
    household_id: deps.householdId,
    kind: result.kind,
    engine: result.ok ? result.engine : (result.engine ?? "none"),
    status,
    source_host: host(sourceUrl),
    input_tokens: result.usage?.input ?? null,
    output_tokens: result.usage?.output ?? null,
    model: result.engine === "anthropic" ? (result.model ?? null) : null,
    prompt_version: result.ok ? result.promptVersion : PROMPT_VERSION,
    extraction: result.ok ? (result.extraction as unknown as Json) : null,
  });
}

/** 今回のAI読み取りの上限（1回あたり・既存の時間/日の上限・月額予算）。0なら読み取らない */
async function aiAllowance(deps: CollectDeps, perRun: number): Promise<{ allowed: number; note: string }> {
  if (!deps.extractor) return { allowed: 0, note: "AIが未設定のため、読み取りは行いません" };
  if (deps.extractor.engine !== "anthropic") return { allowed: perRun, note: "" };
  const hourly = Number(process.env.AI_HOURLY_LIMIT) > 0 ? Number(process.env.AI_HOURLY_LIMIT) : 20;
  const daily = Number(process.env.AI_DAILY_LIMIT) > 0 ? Number(process.env.AI_DAILY_LIMIT) : 60;
  const since = (ms: number) => new Date(deps.now.getTime() - ms).toISOString();
  const [h, d] = await Promise.all([
    deps.db.from("ai_extraction_logs").select("id", { count: "exact", head: true }).eq("household_id", deps.householdId).gte("created_at", since(3600_000)).neq("status", "not_configured"),
    deps.db.from("ai_extraction_logs").select("id", { count: "exact", head: true }).eq("household_id", deps.householdId).gte("created_at", since(86400_000)).neq("status", "not_configured"),
  ]);
  const left = Math.min(hourly - (h.count ?? 0), daily - (d.count ?? 0));
  if (left <= 0) return { allowed: 0, note: "AI読み取りの利用回数の上限に達しているため、続きは次回に回します" };
  try {
    const b = await monthBudget(deps.db);
    if (b.blocked) return { allowed: 0, note: "AIの月間予算を超えているため、読み取りは行いません" };
  } catch {
    /* 予算の取得に失敗しても、回数の上限は守る */
  }
  return { allowed: Math.min(perRun, left), note: left < perRun ? "AI読み取りの利用上限に近いため、続きは次回に回します" : "" };
}

/** 登録に十分な情報があるか（マスター照合が確実・締切が分かる・方式が確定・出典あり） */
export function isReady(draft: LotteryDraft): { ready: boolean; missing: string[] } {
  const sure = (k: string) => k === "exact" || k === "alias" || k === "code";
  const missing: string[] = [];
  if (!sure(draft.summary.chain)) missing.push("系列を確実に特定できません");
  const online = draft.input.receiveMethod === "shipping";
  if (!sure(draft.summary.store) && !online) missing.push("店舗を確実に特定できません");
  if (draft.summary.items.length === 0 || draft.summary.items.some((i) => !sure(i.kind))) missing.push("商品を確実に判別できません");
  if (draft.input.applyDeadline.precision === "unknown") missing.push("応募締切が不明です");
  if (draft.modePending) missing.push("複数商品の応募方式が不明です");
  if ((draft.input.sourceUrls ?? []).length === 0) missing.push("情報源URLがありません");
  return { ready: missing.length === 0, missing };
}

async function appendSourceUrl(db: Db, lotteryId: string, url: string): Promise<boolean> {
  const { data } = await db.from("lotteries").select("source_urls").eq("id", lotteryId).maybeSingle();
  if (!data) return false;
  const cur = data.source_urls ?? [];
  if (cur.includes(url) || cur.length >= 10) return false;
  // 抽選の確定情報には触れず、情報源URLの追加だけを行う
  const { error } = await db.from("lotteries").update({ source_urls: [...cur, url] }).eq("id", lotteryId);
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
}

/** 候補を1件処理する(関連判定は済み)。AIを呼んだら true */
async function processCandidate(deps: CollectDeps, data: AppData, cond: CollectionConditions, autoRegister: boolean, c: CandidateRow, q: QueuedPayload["queued"]): Promise<{ usedAi: boolean; registered: boolean }> {
  const { db } = deps;
  const resolve = (patch: Record<string, unknown>) => db.from("collection_candidates").update({ ...patch, resolved_at: deps.now.toISOString() }).eq("id", c.id);
  const retry = async (message: string) => {
    const attempts = q.attempts + 1;
    // 一時的な失敗は上限回数まで再試行する(失敗した理由を保持)。上限を超えたら失敗として確定
    await db
      .from("collection_candidates")
      .update({ status: "failed", reasons: [message, attempts >= MAX_ATTEMPTS ? "再試行の上限に達しました" : "次回の収集で再試行します"], draft: { queued: { ...q, attempts } } as unknown as Json })
      .eq("id", c.id);
  };

  let result: ExtractResult;
  const extractor = deps.extractor!;
  if (q.kind === "x_post" && q.post) {
    const p = q.post;
    let text = p.text;
    // リンク先(抽選案内)があれば、アクセスできる範囲で本文を統合する(1件まで)
    const ext = p.links.find((l) => !/^https:\/\/(x|twitter)\.com\//.test(l));
    if (ext) {
      const pg = await (deps.fetchPage ?? ((u: string) => fetchRespectingRobots(u)))(ext);
      if (pg.ok) {
        const t = extractPageText(pg.body, pg.finalUrl);
        if (t.text.length >= 30) text += `\n\n【リンク先の案内（${ext}）】\n${t.text.slice(0, 6000)}`;
      }
    }
    const images: NonNullable<ExtractRequest["images"]> = [];
    for (const u of p.images.slice(0, MAX_IMAGES)) {
      const img = await (deps.fetchImage ?? fetchXImage)(u);
      if (img) images.push({ mediaType: img.mediaType, base64: img.base64 });
    }
    let used = images;
    if (images.length > 0) {
      const split = await splitTallImages(images);
      if (split.ok) used = split.images.slice(0, MAX_IMAGES);
    }
    const kind = used.length > 0 ? "image" : "x_url";
    result = await extractFromRequest({ kind, text: text.slice(0, 20_000), images: used.length ? used : undefined, sourceUrl: q.url, postedOn: p.createdAt.slice(0, 10) || undefined, now: deps.now }, kind, extractor, deps.now, []);
  } else {
    result = await runExtraction({ kind: q.kind === "x_oembed" ? "x_url" : "url", url: q.url }, { extractor, now: deps.now, fetchPage: deps.fetchPage, fetchX: deps.fetchOembed });
  }
  await logAi(deps, result, q.url).catch(() => undefined);

  if (!result.ok) {
    if (result.code === "not_lottery" || result.code === "nothing_found") await resolve({ status: "excluded", reasons: ["抽選の告知とは判断できませんでした"], draft: null });
    else await retry(result.message);
    return { usedAi: result.code !== "fetch_failed", registered: false };
  }

  const draft = buildDraft(result.extraction, data, { sourceUrl: q.url });
  // 自動収集は★管理対象にせず、応募記録も作らない
  const input: LotteryInput = { ...draft.input, isManaged: false, applications: [], sourceUrls: [...new Set([...(draft.input.sourceUrls ?? []), q.url])].slice(0, 10) };
  const store = data.stores.find((s) => s.id === input.store.id);
  const dist = store ? storeDistance(data, store) : null;
  const ev = evaluateCandidate(input, cond, { prefecture: store?.prefecture || input.store.prefecture || "", storeKind: store?.salesKind ?? "physical", distanceKm: dist ? dist.km : null, now: deps.now });
  const { ready, missing } = isReady(draft);
  const stored = { input, flags: draft.flags, summary: draft.summary, modePending: draft.modePending, warnings: draft.warnings.slice(0, 10), notices: result.notices.slice(0, 5), verdict: ev.verdict, ready, confirmedAt: deps.now.toISOString(), engine: result.engine } as unknown as Json;

  const high = draft.duplicates.find((d) => d.level === "high");
  if (high) {
    const added = await appendSourceUrl(db, high.lotteryId, q.url);
    await resolve({ status: "duplicate", lottery_id: high.lotteryId, reasons: [high.reason, added ? "既存の抽選に情報源URLを追加しました" : "既存の抽選と同じ情報です"], draft: stored });
    return { usedAi: true, registered: false };
  }
  if (ev.verdict === "exclude") {
    await resolve({ status: "excluded", reasons: ev.reasons, draft: stored });
    return { usedAi: true, registered: false };
  }
  const reasons = [...ev.reasons, ...(ev.verdict === "match" ? missing : missing), ...draft.duplicates.map((d) => d.reason)];
  if (ev.verdict === "match" && ready && draft.duplicates.length === 0) {
    if (autoRegister && deps.canRegister) {
      const saved = await saveLottery(db, deps.householdId, null, input, deps.actor);
      if (saved.ok) {
        // 自動収集の印。NEW表示は新規に把握した時点を基準にする
        await db.from("lotteries").update({ source_kind: "auto", is_new: true }).eq("id", saved.value.id);
        await resolve({ status: "auto_registered", lottery_id: saved.value.id, reasons: ["条件に一致し、情報が十分なため自動登録しました"], draft: stored });
        return { usedAi: true, registered: true };
      }
      await db.from("collection_candidates").update({ status: "pending", reasons: [`自動登録できませんでした: ${saved.error}`], draft: stored }).eq("id", c.id);
      return { usedAi: true, registered: false };
    }
    await db.from("collection_candidates").update({ status: "pending", reasons: ["登録可能です（定期実行ではログインが必要なため、候補として保留しています）"], draft: stored }).eq("id", c.id);
    return { usedAi: true, registered: false };
  }
  await db.from("collection_candidates").update({ status: "pending", reasons: reasons.length ? reasons : ["内容を確認してください"], draft: stored }).eq("id", c.id);
  return { usedAi: true, registered: false };
}

export async function runCollection(deps: CollectDeps): Promise<CollectOutcome> {
  const { db, householdId, now } = deps;
  const started = Date.now();
  const budgetMs = deps.budgetMs ?? 48_000;
  const timeLeft = () => budgetMs - (Date.now() - started);

  await ensureCollectionDefaults(db, householdId);
  // 異常終了した古い実行を閉じる(多重実行防止の「実行中」が残り続けないように)
  await db.from("collection_runs").update({ status: "failed", finished_at: new Date().toISOString() }).eq("household_id", householdId).eq("status", "running").lt("started_at", new Date(Date.now() - STALE_RUN_MS).toISOString());
  const ins = await db.from("collection_runs").insert({ household_id: householdId, trigger: deps.trigger }).select("id").single();
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
  try {
    const [setRes, srcRes] = await Promise.all([
      db.from("collection_settings").select("*").eq("household_id", householdId).limit(1).maybeSingle(),
      db.from("collection_sources").select("*").eq("household_id", householdId).order("created_at"),
    ]);
    const settings = setRes.data;
    if (!settings) throw new Error("settings");
    const cond = conditionsFromRow(settings as unknown as Record<string, unknown>);
    let sources = ((srcRes.data ?? []) as unknown as SourceRow[]).filter((s) => s.enabled && (!deps.onlySourceIds || deps.onlySourceIds.includes(s.id)));
    if (deps.trigger === "cron") {
      sources = sources.filter((s) => !s.last_attempt_at || now.getTime() - new Date(s.last_attempt_at).getTime() >= s.interval_hours * 3600_000 - 5 * 60_000);
    }
    let data = await loadAppData(db, householdId);
    const allow = await aiAllowance(deps, settings.max_ai_per_run);
    if (allow.note) notices.push(allow.note);
    let aiLeft = allow.allowed;

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
          await touch(s, { status: blocked ? "blocked" : "error", error_message: message.slice(0, 500), last_item_count: 0, last_new_count: 0 });
          reports.push({ sourceId: s.id, name: s.name, status: blocked ? "blocked" : "error", message, items: 0, newCount: 0 });
          errors++;
          continue;
        }
        webFetched++;
        const entries = parseListing((s.adapter === "pokeso" || s.adapter === "torecabiyori" ? s.adapter : "generic") as AdapterId, res.body, res.finalUrl);
        if (entries.length === 0) {
          const message = "一覧から告知リンクを取得できませんでした。サイトの構造が変わったか、このサイト用の解析設定が必要です";
          await touch(s, { status: "needs_setup", error_message: message, last_item_count: 0, last_new_count: 0 });
          reports.push({ sourceId: s.id, name: s.name, status: "needs_setup", message, items: 0, newCount: 0 });
          errors++;
          continue;
        }
        const rows: Record<string, unknown>[] = [];
        for (const e of entries as ListingEntry[]) {
          const rel = judgeRelevance(`${e.title} ${e.context}`, { fromPokemonList: true });
          if (!rel.relevant || (!looksLikeLottery(`${e.title} ${e.context}`) && e.kind !== "x_post" && rel.uncertain && !/chusen|lottery|entry|campaign|news|blog|event/i.test(e.url))) continue;
          const key = e.kind === "x_post" ? `x:${/(\d{5,25})$/.exec(e.url)![1]}` : e.url;
          const payload: QueuedPayload = { queued: { kind: e.kind === "x_post" ? "x_oembed" : "web_page", url: e.url, title: e.title, context: e.context, sourceName: s.name, attempts: 0 } };
          rows.push({ household_id: householdId, source_id: s.id, dedupe_key: key.slice(0, 500), source_url: e.url.slice(0, 500), title: (e.title.length >= 10 ? e.title : e.context.slice(-80) || e.title || e.url).slice(0, 200), status: "pending", reasons: ["解析待ち"], draft: payload });
          if (rows.length >= MAX_NEW_PER_SOURCE * 3) break;
        }
        const ins2 = await db.from("collection_candidates").upsert(rows as never, { onConflict: "household_id,dedupe_key", ignoreDuplicates: true }).select("id");
        const added = ins2.data?.length ?? 0;
        newCount += added;
        await touch(s, { status: "ok", error_message: null, last_success_at: now.toISOString(), last_item_count: entries.length, last_new_count: added });
        reports.push({ sourceId: s.id, name: s.name, status: "ok", message: `リンク${entries.length}件を確認、新しい候補${added}件`, items: entries.length, newCount: added });
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
        const r = await deps.xClient.userPosts(userId, s.x_username!, { sinceId: s.x_since_id, max: want });
        if (!r.ok) {
          await touch(s, { status: "error", error_message: r.message });
          reports.push({ sourceId: s.id, name: s.name, status: "error", message: r.message, items: 0, newCount: 0 });
          errors++;
          if (r.code === "credits_depleted" || r.code === "unauthorized" || r.code === "rate_limited") notices.push(r.message);
          continue;
        }
        xBilled += r.posts.length;
        const rows: Record<string, unknown>[] = [];
        for (const p of r.posts as XPost[]) {
          const rel = judgeRelevance(p.text, { fromPokemonList: false });
          const hasImg = p.images.length > 0;
          // 画像だけの告知にも対応する: 本文がポケモンカードに言及するか、画像つきで抽選の言及がある投稿を対象にする
          const likely = rel.relevant || (hasImg && looksLikeLottery(p.text) && rel.uncertain);
          if (!likely) continue;
          const payload: QueuedPayload = { queued: { kind: "x_post", url: p.url, title: p.text.slice(0, 80), context: "", sourceName: s.name, attempts: 0, post: { id: p.id, text: p.text, images: p.images, links: p.links, createdAt: p.createdAt } } };
          rows.push({ household_id: householdId, source_id: s.id, dedupe_key: `x:${p.id}`, source_url: p.url, x_post_id: p.id, title: p.text.slice(0, 80).replace(/\n/g, " ") || p.url, status: "pending", reasons: ["解析待ち"], draft: payload });
        }
        const ins3 = rows.length ? await db.from("collection_candidates").upsert(rows as never, { onConflict: "household_id,dedupe_key", ignoreDuplicates: true }).select("id") : { data: [] as { id: string }[] };
        const added = ins3.data?.length ?? 0;
        newCount += added;
        // 取得した投稿はすべて候補として保存済みなので、次回は続きから取得する
        await touch(s, { status: "ok", error_message: null, last_success_at: now.toISOString(), last_item_count: r.posts.length, last_new_count: added, ...(r.newestId ? { x_since_id: r.newestId } : {}) });
        reports.push({ sourceId: s.id, name: s.name, status: "ok", message: `投稿${r.posts.length}件を取得、新しい候補${added}件`, items: r.posts.length, newCount: added });
      }
    }

    // ------------------------------------------------ 解析(キューを順に。上限・時間の範囲で)
    const queue = await db
      .from("collection_candidates")
      .select("id,dedupe_key,source_url,title,draft,status,fetched_at,source_id")
      .eq("household_id", householdId)
      .in("status", ["pending", "failed"])
      .order("created_at")
      .limit(200);
    const items = ((queue.data ?? []) as unknown as CandidateRow[]).filter((c) => {
      const q = (c.draft as unknown as Partial<QueuedPayload> | null)?.queued;
      if (!q) return false;
      if (c.status === "failed") return q.attempts < MAX_ATTEMPTS && now.getTime() - new Date(c.fetched_at).getTime() > 3600_000;
      return true;
    });
    let leftover = 0;
    for (const c of items) {
      const q = (c.draft as unknown as QueuedPayload).queued;
      if (aiLeft <= 0 || timeLeft() < 12_000) {
        leftover++;
        continue;
      }
      // 参照の欠けた候補(収集元が削除された等)も処理する
      aiLeft--;
      const out = await processCandidate(deps, data, cond, settings.auto_register, c, q).catch(async () => {
        await db.from("collection_candidates").update({ status: "failed", reasons: ["解析中にエラーが発生しました"] }).eq("id", c.id);
        return { usedAi: true, registered: false };
      });
      if (out.usedAi) aiCalls++;
      if (out.registered) {
        registered++;
        // 登録した抽選を、以降の重複検出に反映する(同じ回の中で同じ抽選を二重に登録しない)
        data = await loadAppData(db, householdId);
      }
    }
    if (leftover > 0) notices.push(`解析待ちが${leftover}件残っています（AI利用上限・時間の都合。次回の収集で続きを解析します）`);

    const pendingRes = await db.from("collection_candidates").select("id", { count: "exact", head: true }).eq("household_id", householdId).eq("status", "pending");
    await db
      .from("collection_runs")
      .update({ status: "done", finished_at: new Date().toISOString(), web_fetched: webFetched, x_posts: xBilled, x_calls: xCalls, ai_calls: aiCalls, new_count: newCount, registered_count: registered, error_count: errors, summary: reports as unknown as Json })
      .eq("id", runId);
    return { ok: true, runId, aiCalls, xCalls, xPosts: xBilled, newCount, registered, errors, pending: pendingRes.count ?? 0, sources: reports, notices };
  } catch {
    await db.from("collection_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_count: errors + 1, summary: reports as unknown as Json }).eq("id", runId);
    return { ok: false, code: "error", message: "収集中にエラーが発生しました" };
  }
}

/** 確認待ちの候補を登録する(利用者のログインで実行)。★管理対象にせず、応募記録は作らない。入力は画面で修正された内容を使える */
export async function registerCandidate(db: Db, householdId: string, actor: string | null, candidateId: string, override?: LotteryInput): Promise<{ ok: true; lotteryId: string } | { ok: false; message: string }> {
  const { data: c } = await db.from("collection_candidates").select("id,draft,status,source_url").eq("id", candidateId).maybeSingle();
  if (!c) return { ok: false, message: "候補が見つかりません" };
  if (c.status === "auto_registered") return { ok: false, message: "登録済みです" };
  const input = override ?? ((c.draft as unknown as { input?: LotteryInput } | null)?.input ?? null);
  if (!input) return { ok: false, message: "登録できる内容がありません（解析前の候補です）" };
  const saved = await saveLottery(db, householdId, null, { ...input, isManaged: false, applications: [] }, actor);
  if (!saved.ok) return { ok: false, message: saved.error };
  await db.from("lotteries").update({ source_kind: "auto", is_new: true }).eq("id", saved.value.id);
  await db.from("collection_candidates").update({ status: "auto_registered", lottery_id: saved.value.id, reasons: ["確認のうえ登録しました"], resolved_at: new Date().toISOString() }).eq("id", candidateId);
  return { ok: true, lotteryId: saved.value.id };
}

export const hashText = sha;
export const normalizeEntryUrl = normalizeUrl;
export { X_COST_PER_POST_JPY };
