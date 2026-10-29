import "server-only";
import { createHash } from "node:crypto";
import { MAX_ACTIVE_JOBS, createJobSchema, normalizeUrl, xPostId, type CreateJobInput, type ItemSource, type JobStatus, type JobSummary, type ItemStatus } from "@/lib/ai-job";
import { getExtractor, PROMPT_VERSION } from "@/lib/ai/provider";
import { runExtraction, type ExtractInput, type ExtractResult } from "@/lib/server/lottery-extract-service";
import { monthBudget } from "@/lib/server/ai-budget";
import { sniffImage } from "@/lib/server/image-sniff";
import type { Db } from "@/lib/server/lottery-service";
import type { Json } from "@/types/database";

/**
 * AI一括解析のジョブ管理（サーバー側）。状態は DB（ai_jobs / ai_job_items）に保存し、ブラウザを閉じても結果は失われない。
 *  - 処理は「項目の取り出し（claim）→ 解析 → 結果の保存」。取り出しは DB 関数で行い、同時実行は世帯ごとに3件まで、
 *    期限（lease）つきなので、途中で止まった項目は期限後に回収され、試行は3回まで（無制限に再試行しない）。
 *  - 月間予算を超えていたら新しい解析は始めない（項目は待機のまま残る）。
 *  - 実行基盤の制約: Vercel の関数は応答後も最大60秒程度しか継続できず、Cronは使わない。そのため、ブラウザを閉じたあとに
 *    進むのは、起動した処理が間に合う範囲（数件）まで。残りは次にアプリを開いたとき自動で再開する（docs/stage5fg.md）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
const any = (db: Db) => db as any;

export const CONCURRENCY = 3;
const NEW_BATCH_UNTIL_MS = 14_000;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 40);

type ParsedItem = ReturnType<typeof createJobSchema.parse>["items"][number];
/** 重複登録の防止キー（URL・X投稿ID・文章・画像）。進行中・確認待ちの間だけ一意（DBの部分一意インデックス） */
export function dedupeKey(item: ParsedItem): string {
  switch (item.source) {
    case "text":
      return `t:${hash(item.text.replace(/\s+/g, " ").trim())}`;
    case "url":
      return `u:${hash(normalizeUrl(item.url))}`;
    case "x_url":
      return xPostId(item.url) ? `x:${xPostId(item.url)}` : `u:${hash(normalizeUrl(item.url))}`;
    case "images":
      return `i:${hash([...item.shas].sort().join(","))}`;
  }
}

type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

// ------------------------------------------------------------------ 作成
export async function createJob(db: Db, householdId: string, actor: string | null, raw: CreateJobInput): Promise<R<{ jobId: string; created: number; skipped: { index: number; reason: string }[] }>> {
  const p = createJobSchema.safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const { count } = await any(db).from("ai_jobs").select("id", { count: "exact", head: true }).in("status", ["queued", "running"]);
  if ((count ?? 0) >= MAX_ACTIVE_JOBS) return fail("解析中のジョブが多すぎます。完了してから追加してください");

  const skipped: { index: number; reason: string }[] = [];
  const keys = new Map<string, number>();
  const rows: { item: ParsedItem; key: string; index: number }[] = [];
  p.data.items.forEach((item, index) => {
    if (item.source === "images" && item.paths.some((x) => !x.startsWith(`${householdId}/`))) {
      skipped.push({ index, reason: "画像の場所が正しくありません" });
      return;
    }
    const key = dedupeKey(item);
    if (keys.has(key)) {
      skipped.push({ index, reason: "同じ内容の項目が重複しています" });
      return;
    }
    keys.set(key, index);
    rows.push({ item, key, index });
  });
  // 進行中・確認待ちの項目と同じ内容は追加しない（二重解析・二重登録の防止）
  if (rows.length > 0) {
    const { data: ex } = await any(db).from("ai_job_items").select("dedupe_key").in("dedupe_key", rows.map((r) => r.key)).in("status", ["queued", "running", "done"]);
    const have = new Set((ex ?? []).map((r: { dedupe_key: string }) => r.dedupe_key));
    for (let i = rows.length - 1; i >= 0; i--) {
      if (have.has(rows[i].key)) {
        skipped.push({ index: rows[i].index, reason: "解析中または確認待ちの項目と同じ内容です" });
        rows.splice(i, 1);
      }
    }
  }
  if (rows.length === 0) return fail("追加できる項目がありません（すべて重複しています）");

  const job = await any(db).from("ai_jobs").insert({ household_id: householdId, created_by_profile_id: actor, label: p.data.label, total_items: rows.length }).select("id").single();
  if (job.error) return fail("ジョブを作成できませんでした");
  const jobId = job.data.id as string;
  const ins = await any(db).from("ai_job_items").insert(
    rows.map((r, i) => ({
      household_id: householdId,
      job_id: jobId,
      position: i,
      source_kind: r.item.source,
      source_text: r.item.source === "text" ? r.item.text : null,
      source_url: r.item.source === "url" || r.item.source === "x_url" ? r.item.url : null,
      image_paths: r.item.source === "images" ? r.item.paths : [],
      dedupe_key: r.key,
    })),
  );
  if (ins.error) {
    await any(db).from("ai_jobs").delete().eq("id", jobId);
    // 同時に同じ項目が作られた場合は、DBの一意制約が二重登録を止める
    return fail(ins.error.code === "23505" ? "同じ内容の項目が既に解析中または確認待ちです" : "ジョブを作成できませんでした");
  }
  return { ok: true, jobId, created: rows.length, skipped: skipped.sort((a, b) => a.index - b.index) };
}

// ------------------------------------------------------------------ 解析の実行
const itemLabel = (it: { source_kind: ItemSource; source_url: string | null }) => (it.source_url ? it.source_url : "");

async function toInput(db: Db, it: Record<string, unknown>): Promise<ExtractInput | { error: string }> {
  const kind = it.source_kind as ItemSource;
  if (kind === "text") return { kind: "text", text: String(it.source_text ?? "") };
  if (kind === "url" || kind === "x_url") return { kind, url: String(it.source_url ?? "") };
  const images: Extract<ExtractInput, { kind: "image" }>["images"] = [];
  let total = 0;
  for (const path of (it.image_paths as string[]) ?? []) {
    const { data, error } = await db.storage.from("job-inputs").download(path);
    if (error || !data) return { error: "入力画像が見つかりません（もう一度画像を追加してください）" };
    const buf = Buffer.from(await data.arrayBuffer());
    total += buf.length;
    if (total > 4_500_000) return { error: "画像の合計サイズが大きすぎます" };
    const mediaType = sniffImage(buf);
    if (!mediaType) return { error: "対応していない画像形式です" };
    images.push({ mediaType, base64: buf.toString("base64") });
  }
  return { kind: "image", images };
}

/** 解析ログ（費用管理・精度評価）。入力した本文・画像そのものは保存しない */
async function logRun(db: Db, householdId: string, input: ExtractInput, result: ExtractResult): Promise<string | null> {
  const status = result.ok
    ? result.extraction.applyDeadline.precision === "unknown" || result.extraction.items.length === 0 || !result.extraction.chainName
      ? "partial"
      : "ok"
    : result.code === "not_configured"
      ? "not_configured"
      : result.code === "rate_limited"
        ? "rate_limited"
        : result.code === "fetch_failed"
          ? "fetch_failed"
          : "failed";
  let host: string | null = null;
  if (input.kind === "url" || input.kind === "x_url") {
    try {
      host = new URL(input.url).hostname.slice(0, 255);
    } catch {
      host = null;
    }
  }
  const { data } = await any(db)
    .from("ai_extraction_logs")
    .insert({
      household_id: householdId,
      kind: result.kind,
      engine: result.ok ? result.engine : (result.engine ?? "none"),
      status,
      source_host: host,
      input_tokens: result.usage?.input ?? null,
      output_tokens: result.usage?.output ?? null,
      model: result.engine === "anthropic" ? (result.model ?? null) : null,
      prompt_version: result.ok ? result.promptVersion : PROMPT_VERSION,
      extraction: result.ok ? (result.extraction as unknown as Json) : null,
    })
    .select("id")
    .single();
  return data?.id ?? null;
}

async function cleanupImages(db: Db, paths: string[]) {
  if (paths.length > 0) await db.storage.from("job-inputs").remove(paths);
}

async function runItem(db: Db, householdId: string, it: Record<string, unknown>): Promise<void> {
  const id = it.id as string;
  const attempts = Number(it.attempts ?? 1);
  const paths = (it.image_paths as string[]) ?? [];
  const finish = (patch: Record<string, unknown>) =>
    // 取り消された項目（status が running でなくなったもの）は上書きしない
    any(db).from("ai_job_items").update({ ...patch, lease_until: null, finished_at: new Date().toISOString() }).eq("id", id).eq("status", "running");

  const input = await toInput(db, it);
  if ("error" in input) {
    await finish({ status: "failed", error_code: "input", error_message: input.error });
    return;
  }
  let result: ExtractResult;
  try {
    result = await runExtraction(input, { extractor: getExtractor(), now: new Date() });
  } catch {
    result = { ok: false, kind: input.kind, code: "ai_failed", message: "解析中にエラーが発生しました" };
  }
  const runId = await logRun(db, householdId, input, result);
  if (result.ok) {
    await finish({
      status: "done",
      result: { extraction: result.extraction, notices: result.notices, promptVersion: result.promptVersion, engine: result.engine, sourceUrl: result.sourceUrl ?? null } as unknown as Json,
      run_id: runId,
      image_paths: [],
      error_code: null,
      error_message: null,
    });
    await cleanupImages(db, paths);
    return;
  }
  // 一時的な失敗（AIの混雑・時間切れ）は、試行回数の上限(3)まで自動で再試行する。それ以外はすぐに失敗にする
  const transient = result.code === "ai_failed" || result.code === "rate_limited";
  if (transient && attempts < 3) {
    await any(db).from("ai_job_items").update({ status: "queued", lease_until: null, run_id: runId, error_code: result.code, error_message: result.message.slice(0, 300) }).eq("id", id).eq("status", "running");
    return;
  }
  await finish({ status: "failed", run_id: runId, error_code: result.code, error_message: result.message.slice(0, 300) });
}

export interface ProcessResult {
  processed: number;
  /** 月間予算に達していて、新しい解析を始めなかった */
  blocked: boolean;
  /** まだ待機中の項目があるか */
  pending: boolean;
}

/**
 * 待機中の項目を、同時3件まで取り出して解析する。時間の予算内で繰り返し、残りは次の呼び出し（次にアプリを開いたとき等）が続ける。
 * 二重に呼ばれても、取り出しは DB 側で排他され、同時実行数も世帯ごとに制限される。
 */
export async function processJobs(db: Db, householdId: string, opts: { budgetMs?: number } = {}): Promise<ProcessResult> {
  const start = Date.now();
  const budget = opts.budgetMs ?? NEW_BATCH_UNTIL_MS;
  let processed = 0;
  let blocked = false;
  const touched = new Set<string>();
  const extractor = getExtractor();
  while (Date.now() - start < budget) {
    if (extractor?.engine === "anthropic") {
      const b = await monthBudget(db);
      if (b.blocked) {
        blocked = true;
        break;
      }
    }
    const { data, error } = await any(db).rpc("claim_ai_job_items", { p_limit: CONCURRENCY, p_lease_secs: 90 });
    if (error || !data || data.length === 0) break;
    await Promise.all((data as Record<string, unknown>[]).map((it) => runItem(db, householdId, it)));
    processed += data.length;
    for (const it of data as Record<string, unknown>[]) touched.add(it.job_id as string);
  }
  for (const id of touched) await any(db).rpc("refresh_ai_job", { p_job: id });
  const { count } = await any(db).from("ai_job_items").select("id", { count: "exact", head: true }).eq("status", "queued");
  return { processed, blocked, pending: (count ?? 0) > 0 };
}

// ------------------------------------------------------------------ 参照
export async function listJobs(db: Db): Promise<{ jobs: JobSummary[]; blocked: boolean; pending: boolean }> {
  const { data: jobs } = await any(db).from("ai_jobs").select("id,label,status,total_items,created_at,completed_at,seen_at").order("created_at", { ascending: false }).limit(30);
  const ids = (jobs ?? []).map((j: { id: string }) => j.id);
  const counts = new Map<string, { done: number; failed: number; saved: number }>();
  let pending = false;
  if (ids.length > 0) {
    const { data: items } = await any(db).from("ai_job_items").select("job_id,status").in("job_id", ids);
    for (const it of items ?? []) {
      const c = counts.get(it.job_id) ?? { done: 0, failed: 0, saved: 0 };
      if (it.status === "done") c.done++;
      else if (it.status === "failed") c.failed++;
      else if (it.status === "saved") c.saved++;
      else if (it.status === "queued") pending = true;
      counts.set(it.job_id, c);
    }
  }
  const out: JobSummary[] = (jobs ?? []).map((j: Record<string, unknown>) => ({
    id: j.id as string,
    label: j.label as string,
    status: j.status as JobStatus,
    total: j.total_items as number,
    ...(counts.get(j.id as string) ?? { done: 0, failed: 0, saved: 0 }),
    createdAt: j.created_at as string,
    completedAt: (j.completed_at as string) ?? null,
    seenAt: (j.seen_at as string) ?? null,
  }));
  const extractor = getExtractor();
  const blocked = pending && extractor?.engine === "anthropic" ? (await monthBudget(db)).blocked : false;
  return { jobs: out, blocked, pending };
}

export interface JobItemView {
  id: string;
  position: number;
  source: ItemSource;
  label: string;
  status: ItemStatus;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  /** 検証済みの抽出結果（確認待ち）。保存前の候補 */
  result: { extraction: unknown; notices: string[]; promptVersion: string; engine: string; sourceUrl: string | null } | null;
  runId: string | null;
  lotteryId: string | null;
}

export async function getJob(db: Db, id: string): Promise<R<{ job: JobSummary; items: JobItemView[] }>> {
  const { data: j } = await any(db).from("ai_jobs").select("id,label,status,total_items,created_at,completed_at,seen_at").eq("id", id).maybeSingle();
  if (!j) return fail("ジョブが見つかりません");
  const { data: items } = await any(db).from("ai_job_items").select("id,position,source_kind,source_url,source_text,image_paths,status,attempts,error_code,error_message,result,run_id,lottery_id").eq("job_id", id).order("position");
  const views: JobItemView[] = (items ?? []).map((it: Record<string, unknown>) => ({
    id: it.id as string,
    position: it.position as number,
    source: it.source_kind as ItemSource,
    label: it.source_kind === "text" ? String(it.source_text ?? "").replace(/\s+/g, " ").slice(0, 60) : it.source_kind === "images" ? "告知画像" : itemLabel(it as never),
    status: it.status as ItemStatus,
    attempts: it.attempts as number,
    errorCode: (it.error_code as string) ?? null,
    errorMessage: (it.error_message as string) ?? null,
    result: (it.result as JobItemView["result"]) ?? null,
    runId: (it.run_id as string) ?? null,
    lotteryId: (it.lottery_id as string) ?? null,
  }));
  const cnt = (s: ItemStatus) => views.filter((v) => v.status === s).length;
  return {
    ok: true,
    job: { id: j.id, label: j.label, status: j.status, total: j.total_items, done: cnt("done"), failed: cnt("failed"), saved: cnt("saved"), createdAt: j.created_at, completedAt: j.completed_at, seenAt: j.seen_at },
    items: views,
  };
}

// ------------------------------------------------------------------ 操作
export type JobAction = { action: "cancel" } | { action: "seen" } | { action: "retry"; itemId: string } | { action: "skip"; itemId: string } | { action: "saved"; itemId: string; lotteryId: string };

export async function jobAction(db: Db, jobId: string, a: JobAction): Promise<R<{ marked?: boolean }>> {
  const uuid = /^[0-9a-f-]{36}$/;
  if (!uuid.test(jobId)) return fail("リクエストが不正です");
  if (a.action === "seen") {
    await any(db).from("ai_jobs").update({ seen_at: new Date().toISOString() }).eq("id", jobId);
    return { ok: true };
  }
  if (a.action === "cancel") {
    const { data } = await any(db).from("ai_job_items").update({ status: "cancelled", lease_until: null, finished_at: new Date().toISOString() }).eq("job_id", jobId).in("status", ["queued", "running"]).select("image_paths");
    await cleanupImages(db, (data ?? []).flatMap((r: { image_paths: string[] }) => r.image_paths));
    await any(db).rpc("refresh_ai_job", { p_job: jobId });
    return { ok: true };
  }
  if (!uuid.test(a.itemId)) return fail("リクエストが不正です");
  if (a.action === "saved") {
    if (!uuid.test(a.lotteryId)) return fail("リクエストが不正です");
    const { data, error } = await any(db).rpc("mark_job_item_saved", { p_item: a.itemId, p_lottery: a.lotteryId });
    if (error) return fail("保存済みの記録に失敗しました");
    return { ok: true, marked: data === true };
  }
  if (a.action === "retry") {
    const { data } = await any(db).from("ai_job_items").update({ status: "queued", attempts: 0, lease_until: null, error_code: null, error_message: null, finished_at: null }).eq("id", a.itemId).eq("job_id", jobId).eq("status", "failed").select("id");
    await any(db).rpc("refresh_ai_job", { p_job: jobId });
    return (data ?? []).length > 0 ? { ok: true } : fail("再試行できない状態です（入力画像は解析の失敗後も残りますが、期限切れの場合は追加し直してください）");
  }
  // skip（保存対象から除外）
  const { data } = await any(db).from("ai_job_items").update({ status: "skipped", finished_at: new Date().toISOString() }).eq("id", a.itemId).eq("job_id", jobId).in("status", ["done", "failed"]).select("image_paths");
  await cleanupImages(db, (data ?? []).flatMap((r: { image_paths: string[] }) => r.image_paths));
  await any(db).rpc("refresh_ai_job", { p_job: jobId });
  return { ok: true };
}
