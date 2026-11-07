import "server-only";
import { deriveBookmarkState, isTerminal, MAX_BOOKMARK_RETRIES, retryDelayMs, toBookmarkView, type BookmarkRowLite, type BookmarkState, type BookmarkView, type CandidateLite } from "@/lib/collector/bookmark-state";
import type { XPost } from "@/lib/collector/x-posts";
import { safeSlice } from "@/lib/text-safe";
import type { Db } from "@/lib/server/lottery-service";

/**
 * Xブックマークの投稿ごとの処理状況の記録と更新（Stage 6N）。AI・X APIは呼ばない（状態の整理だけ）。
 *  - 投稿ID単位で1行。同じ投稿を再同期しても重複しない（既存の行は上書きしない）
 *  - 状態は候補（collection_candidates）の進み具合から導く。取得できたことと、抽選として登録できたことは別の状態
 *  - 利用者が「対象外」「調査終了」を選んだ行は、以後の自動更新・再調査の対象にしない
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表の型を最小限で扱う
const tbl = (db: Db) => (db as unknown as { from: (t: string) => any }).from("x_bookmark_posts");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const raw = (db: Db, t: string) => (db as unknown as { from: (t: string) => any }).from(t);

const COLS = "id,post_id,username,display_name,post_url,summary,state,reason,failure_kind,deadline_at,popup_shown_at,user_closed_at,first_seen_at,supplement_note,candidate_id,lottery_id,retry_count,next_retry_at";

export type BookmarkOutcome = "queued" | "known" | "irrelevant";

/** URL・改行を除いた短い要約 */
export function summarizePost(text: string): string {
  return safeSlice(text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim(), 100);
}

/** 同期で見つけた投稿を記録する。すでにある投稿の行は変えない（重複登録しない） */
export async function recordBookmarkPosts(db: Db, householdId: string, items: { post: XPost; outcome: BookmarkOutcome; reason?: string }[], now: Date): Promise<number> {
  if (items.length === 0) return 0;
  const rows = items.map(({ post: p, outcome, reason }) => ({
    household_id: householdId,
    post_id: p.id,
    username: (p.username ?? "").slice(0, 40),
    display_name: (p.profile?.name ?? "").slice(0, 100),
    post_url: p.url.slice(0, 500),
    summary: summarizePost(p.text),
    // 候補に入れた投稿は解析待ち。関係ない投稿は対象外。既知の投稿は、あとの更新で候補の状態から決める
    state: outcome === "irrelevant" ? "excluded" : "fetched_pending",
    reason: outcome === "irrelevant" ? (reason ?? "抽選の告知とは判断できませんでした").slice(0, 300) : outcome === "queued" ? "解析の順番を待っています" : "",
    first_seen_at: now.toISOString(),
  }));
  const { error } = await tbl(db).upsert(rows, { onConflict: "household_id,post_id", ignoreDuplicates: true });
  return error ? 0 : rows.length;
}

interface CandRow extends CandidateLite {
  id: string;
  dedupe_key: string;
  reasons: string[] | null;
}

type Row = BookmarkRowLite & { candidate_id: string | null; lottery_id: string | null; retry_count: number; next_retry_at: string | null };

/**
 * 未完了の行の状態を、候補の現在の状態に合わせて更新する。受付終了後は自動再調査を止め、「受付終了・未解決」として履歴に残す。
 * 変更があった件数を返す。
 */
export async function refreshBookmarkStates(db: Db, householdId: string, now: Date): Promise<number> {
  const { data } = await tbl(db).select(COLS).eq("household_id", householdId).is("user_closed_at", null).limit(500);
  const rows = ((data ?? []) as Row[]).filter((r) => !isTerminal(r.state));
  if (rows.length === 0) return 0;
  const keys = rows.map((r) => `x:${r.post_id}`);
  const { data: cands } = await raw(db, "collection_candidates")
    .select("id,dedupe_key,status,job_state,fail_kind,lottery_id,triage,manual_state,due_at,draft,last_error,reasons")
    .eq("household_id", householdId)
    .in("dedupe_key", keys);
  const byKey = new Map<string, CandRow>(((cands ?? []) as CandRow[]).map((c) => [c.dedupe_key, c]));
  // 候補が無い投稿: 登録済みの抽選の情報元URLにあれば「既存抽選と統合済み」。優先収集メモ（追跡）にあれば「情報不足・追加調査中」
  const need = rows.filter((r) => !byKey.has(`x:${r.post_id}`));
  const inLottery = new Set<string>();
  const inMemo = new Set<string>();
  if (need.length > 0) {
    const urls = need.map((r) => r.post_url).filter(Boolean);
    const [lot, memo] = await Promise.all([
      raw(db, "lotteries").select("id,source_urls").eq("household_id", householdId).overlaps("source_urls", urls),
      raw(db, "collection_memos").select("reference_url").eq("household_id", householdId).in("reference_url", urls),
    ]);
    for (const l of (lot.data ?? []) as { source_urls: string[] }[]) for (const u of l.source_urls ?? []) inLottery.add(u);
    for (const m of (memo.data ?? []) as { reference_url: string }[]) inMemo.add(m.reference_url);
  }
  let changed = 0;
  for (const r of rows) {
    const c = byKey.get(`x:${r.post_id}`) ?? null;
    let d = deriveBookmarkState(c, now);
    if (!c && inLottery.has(r.post_url)) d = { state: "merged", reason: "登録済みの抽選の情報元として確認できました", failureKind: null };
    else if (!c && inMemo.has(r.post_url)) d = { state: "insufficient", reason: "情報が不足しているため、ほかの情報源で補完します", failureKind: null };
    const patch: Record<string, unknown> = {};
    const next = d.state as BookmarkState;
    if (next !== r.state) patch.state = next;
    if (d.reason !== r.reason) patch.reason = d.reason;
    if ((d.failureKind ?? null) !== (r.failure_kind ?? null)) patch.failure_kind = d.failureKind;
    if (c && c.id !== r.candidate_id) patch.candidate_id = c.id;
    if (c?.lottery_id && c.lottery_id !== r.lottery_id) patch.lottery_id = c.lottery_id;
    if (c?.due_at && c.due_at !== r.deadline_at) patch.deadline_at = c.due_at;
    if (next === "merged" && c && next !== r.state) {
      patch.supplement_note = (c.reasons?.[0] ?? "別の情報源と照合して統合しました").slice(0, 500);
      patch.supplemented_at = now.toISOString();
    }
    // 未解決になった行は、次の自動再調査の時刻を決める。終端（登録・統合・対象外・受付終了）は再調査しない
    if (isTerminal(next)) patch.next_retry_at = null;
    else if ((next === "fetch_failed" || next === "insufficient" || next === "manual_review") && !r.next_retry_at) patch.next_retry_at = new Date(now.getTime() + retryDelayMs(r.retry_count)).toISOString();
    if (Object.keys(patch).length === 0) continue;
    const { error } = await tbl(db).update({ ...patch, last_attempt_at: now.toISOString() }).eq("id", r.id);
    if (!error) changed++;
  }
  return changed;
}

/** 優先して補完・統合する対象（未解決で、利用者が終了していない行の候補ID。受付が終わった行は再評価で終端になる） */
export async function unresolvedBookmarkCandidateIds(db: Db, householdId: string, due?: Date): Promise<string[]> {
  let q = tbl(db).select("candidate_id").eq("household_id", householdId).is("user_closed_at", null).in("state", ["insufficient", "manual_review", "fetch_failed"]).not("candidate_id", "is", null).lt("retry_count", MAX_BOOKMARK_RETRIES).or("failure_kind.is.null,failure_kind.neq.permanent");
  // 次回の再調査の時刻を過ぎたものだけ（毎回の呼び出しで試行回数を増やさない）
  if (due) q = q.lte("next_retry_at", due.toISOString());
  const { data } = await q.limit(100);
  return ((data ?? []) as { candidate_id: string }[]).map((r) => r.candidate_id);
}

/** 再調査の試行を記録し、次回の時刻を延ばす（自動再調査の回数・間隔の管理） */
export async function bumpRetry(db: Db, householdId: string, candidateIds: string[], now: Date): Promise<void> {
  if (candidateIds.length === 0) return;
  const { data } = await tbl(db).select("id,retry_count").eq("household_id", householdId).in("candidate_id", candidateIds);
  for (const r of (data ?? []) as { id: string; retry_count: number }[]) {
    await tbl(db).update({ retry_count: r.retry_count + 1, last_attempt_at: now.toISOString(), next_retry_at: new Date(now.getTime() + retryDelayMs(r.retry_count + 1)).toISOString() }).eq("id", r.id);
  }
}

export interface BookmarkPanel {
  /** 起動時ポップアップにまだ表示していない新規（すべて個別に表示する） */
  fresh: BookmarkView[];
  /** 未解決（問題が解決するか、利用者が終了するまで残す） */
  unresolved: BookmarkView[];
  /** 表示後に「表示済み」にする行のID */
  shownIds: string[];
  /** 同期そのものの失敗（API・認証など）。取得できた投稿の状態とは別に表示する */
  syncIssue: string | null;
}

/** 画面用: 新規＋未解決。呼び出しの前に状態を更新する（失敗しても表示は続ける） */
export async function loadBookmarkPanel(db: Db, householdId: string, now = new Date()): Promise<BookmarkPanel> {
  await refreshBookmarkStates(db, householdId, now).catch(() => 0);
  const { data } = await tbl(db).select(COLS).eq("household_id", householdId).order("first_seen_at", { ascending: false }).limit(300);
  const rows = (data ?? []) as BookmarkRowLite[];
  const views = rows.map((r) => ({ v: toBookmarkView(r), closed: !!r.user_closed_at }));
  const fresh = views.filter((x) => x.v.isNew && !x.closed).map((x) => x.v);
  const link = await raw(db, "x_bookmark_links").select("last_error,status").eq("household_id", householdId).maybeSingle();
  const issue = (link.data?.last_error as string | undefined) ?? "";
  return { fresh, unresolved: views.filter((x) => x.v.unresolved && !x.v.isNew).map((x) => x.v), shownIds: fresh.map((v) => v.id), syncIssue: issue ? issue.slice(0, 200) : null };
}

/** 起動時ポップアップに表示した行を「表示済み」にする（再起動のたびに同じ新規として繰り返さない） */
export async function markBookmarksShown(db: Db, householdId: string, ids: string[], now = new Date()): Promise<void> {
  if (ids.length === 0) return;
  await tbl(db).update({ popup_shown_at: now.toISOString() }).eq("household_id", householdId).in("id", ids.slice(0, 200)).is("popup_shown_at", null);
}

/** 利用者が「対象外」「調査終了」を選ぶ。未解決一覧から外れ、自動再調査も止まる（履歴は残す） */
export async function closeBookmark(db: Db, householdId: string, id: string, kind: "excluded" | "investigation_ended", now = new Date()): Promise<boolean> {
  const { data, error } = await tbl(db)
    .update({ user_closed_at: now.toISOString(), user_closed_kind: kind, next_retry_at: null, ...(kind === "excluded" ? { state: "excluded", reason: "利用者が対象外にしました" } : {}) })
    .eq("household_id", householdId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  return !error && !!data;
}
