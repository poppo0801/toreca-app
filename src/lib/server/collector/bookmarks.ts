import "server-only";
import { classifyXError, parseXPosts, type XApiErrorCode, type XPost } from "@/lib/collector/x-posts";
import { judgeXPost } from "@/lib/collector/x-relevance";
import { safeSlice } from "@/lib/text-safe";
import { EXPANSIONS, TWEET_FIELDS, X_API_BASE } from "@/lib/server/collector/x-client";
import { xBudgetLeft } from "@/lib/server/collector/x-rich";
import { saveCandidateRows } from "@/lib/server/collector/save-rows";
import { recordBookmarkPosts, refreshBookmarkStates, type BookmarkOutcome } from "@/lib/server/collector/bookmark-track";
import { acquireLease, getAccessToken, loadLink, markNeedsReauth, oauthConfig, releaseLease, type OAuthConfig } from "@/lib/server/x-oauth-server";
import type { Db } from "@/lib/server/lottery-service";

/**
 * Xブックマークの同期（Stage 6I）。取得した投稿は、既存のX投稿と同じ解析キュー（collection_candidates → AI解析 → 自動登録判定／追跡）に入る。
 *  - 有料のX APIを使うため、収集設定の「X APIを使う」と月額予算の範囲内でだけ動く。使用量は collection_runs(phase=bookmark) に記録し、既存の月額集計に含める
 *  - 初回は過去分を無条件に取り込まない（直近 INITIAL_DAYS 日・最大 INITIAL_MAX 件）。以後は前回の先頭より新しいものだけを読む
 *  - ブックマークが外されても、収集済みの候補・抽選・応募・購入・メモは削除しない
 */

export const BOOKMARK_INITIAL_DAYS = 14;
export const BOOKMARK_INITIAL_MAX = 20;
/** 2回目以降の1回あたりの読み取り上限と、最初のページの大きさ（先頭の既読分を読み直す課金を小さくする） */
export const BOOKMARK_SYNC_MAX = 20;
export const BOOKMARK_FIRST_PAGE = 5;
/** 自動同期の最小間隔（定期ワーカーから） */
export const BOOKMARK_MIN_INTERVAL_MS = 12 * 3600_000;
export const BOOKMARK_SOURCE_NAME = "Xブックマーク";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
const tbl = (db: Db, name: string) => (db as unknown as { from: (t: string) => any }).from(name);

type FetchFail = { ok: false; code: XApiErrorCode | "reauth"; message: string };
export type BookmarkPage = { ok: true; posts: XPost[]; nextToken: string | null } | FetchFail;

/** ブックマークの1ページ。ユーザーのアクセストークンで公式APIを呼ぶ（接続先は api.x.com に固定） */
export async function fetchBookmarkPage(accessToken: string, xUserId: string, o: { max: number; token?: string | null }): Promise<BookmarkPage> {
  if (!/^[0-9]{1,25}$/.test(xUserId)) return { ok: false, code: "unknown", message: "連携したアカウントのIDが不正です" };
  const params = new URLSearchParams({
    max_results: String(Math.min(100, Math.max(1, o.max))),
    "tweet.fields": TWEET_FIELDS,
    "user.fields": "username,name,location,description",
    expansions: EXPANSIONS,
    "media.fields": "type,url",
  });
  if (o.token) params.set("pagination_token", o.token);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch(`${X_API_BASE}/users/${xUserId}/bookmarks?${params}`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, signal: ctl.signal, redirect: "error", cache: "no-store" });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.status === 401) return { ok: false, code: "reauth", message: "Xの認証が無効です。再連携してください" };
    if (!res.ok) {
      const e = classifyXError(res.status, json);
      // 403: ブックマークの権限・プランが無い。Bearer の文言は出さない
      return { ok: false, code: e.code, message: res.status === 403 ? "X APIでブックマークの取得が許可されていません（権限またはプランを確認してください）" : e.message };
    }
    const next = (json as { meta?: { next_token?: unknown } } | null)?.meta?.next_token;
    const posts = parseXPosts(json, "").map((p) => ({ ...p, url: `https://x.com/${p.username || "i"}/status/${p.id}` }));
    return { ok: true, posts, nextToken: typeof next === "string" && next.length < 300 ? next : null };
  } catch {
    return { ok: false, code: "network", message: "X APIに接続できませんでした" };
  } finally {
    clearTimeout(timer);
  }
}

export interface BookmarkSyncResult {
  ok: boolean;
  message: string;
  /** 読み取った投稿数（課金対象の見積り＝引用元を含む） */
  billed: number;
  fetched: number;
  added: number;
  known: number;
  irrelevant: number;
}
const empty = (ok: boolean, message: string): BookmarkSyncResult => ({ ok, message, billed: 0, fetched: 0, added: 0, known: 0, irrelevant: 0 });

export interface BookmarkSyncDeps {
  db: Db;
  householdId: string;
  trigger: "manual" | "cron";
  now?: Date;
  cfg?: OAuthConfig | null;
  /** テスト用: ページ取得の差し替え */
  fetchPage?: typeof fetchBookmarkPage;
}

/** 既に分かっている投稿（収集候補・抽選・優先収集メモ）。ここに無いものだけを新規の候補にする */
async function knownPostIds(db: Db, householdId: string, posts: XPost[]): Promise<Set<string>> {
  const known = new Set<string>();
  if (posts.length === 0) return known;
  const ids = posts.map((p) => p.id);
  const urls = posts.map((p) => p.url);
  const [cand, lot, memo] = await Promise.all([
    db.from("collection_candidates").select("x_post_id,dedupe_key").eq("household_id", householdId).in("dedupe_key", ids.map((i) => `x:${i}`)),
    tbl(db, "lotteries").select("source_urls").eq("household_id", householdId).overlaps("source_urls", urls),
    tbl(db, "collection_memos").select("reference_url").eq("household_id", householdId).in("reference_url", urls),
  ]);
  for (const c of cand.data ?? []) known.add(String(c.dedupe_key).replace(/^x:/, ""));
  const urlToId = new Map(posts.map((p) => [p.url, p.id]));
  for (const l of (lot.data ?? []) as { source_urls: string[] }[]) for (const u of l.source_urls ?? []) if (urlToId.has(u)) known.add(urlToId.get(u)!);
  for (const m of (memo.data ?? []) as { reference_url: string }[]) if (urlToId.has(m.reference_url)) known.add(urlToId.get(m.reference_url)!);
  return known;
}

/**
 * 1回の同期。予算・設定・認証がそろっていなければ、X APIを1回も呼ばない。
 * 呼び出し側（画面の「今すぐ同期」と定期ワーカー）は、利用者の許可（連携＋自動同期ON、または手動操作）を確認してから呼ぶこと。
 */
export async function runBookmarkSync(deps: BookmarkSyncDeps): Promise<BookmarkSyncResult> {
  const { db, householdId } = deps;
  const now = deps.now ?? new Date();
  const cfg = deps.cfg === undefined ? oauthConfig() : deps.cfg;
  const fetchPage = deps.fetchPage ?? fetchBookmarkPage;
  if (!cfg) return empty(false, "X連携の環境変数（Client ID / Secret / 暗号化キー）が未設定です");
  const link = await loadLink(db, householdId);
  if (!link) return empty(false, "Xアカウントが連携されていません");
  if (link.status === "needs_reauth") return empty(false, "認証が切れています。Xアカウントを再連携してください");

  // 予算: 収集設定の「X APIを使う」と月額予算。引用元も読み取りの対象になるため、1件あたり最大2件ぶんで見積もる
  const budget = await xBudgetLeft(db, householdId, now);
  if (!budget.enabled) return empty(false, "X APIの利用が無効です（設定の自動収集でX APIを有効にし、月額予算を設定してください）");
  let remaining = budget.remaining;
  if (remaining < 4) return empty(false, "X APIの今月の予算上限に達しているため、同期を停止しています");

  if (!(await acquireLease(db, link.id, now))) return empty(false, "別の同期が実行中です。少し待ってからもう一度お試しください");
  const res = empty(true, "");
  let calls = 0;
  let newestId: string | null = link.newest_bookmark_id;
  let failure: string | null = null;
  try {
    const at = await getAccessToken(db, cfg, link, now);
    if (!at.ok) {
      failure = at.message;
    } else {
      const initial = !link.initial_synced_at;
      const cap = initial ? BOOKMARK_INITIAL_MAX : Math.min(BOOKMARK_SYNC_MAX, Math.max(1, budget.maxPostsPerRun));
      const collected: XPost[] = [];
      let token: string | null = null;
      let reachedKnown = false;
      let topId: string | null = null;
      // 初回は1ページ(最大cap件)。2回目以降は小さなページから読み、前回の先頭に届くまで（上限cap件）続ける
      while (collected.length < cap && !reachedKnown) {
        const size = initial ? cap : Math.min(collected.length === 0 ? BOOKMARK_FIRST_PAGE : cap - collected.length, cap - collected.length);
        // 残りの予算で読める件数に収める（引用元ぶんを考えて半分）
        const afford = Math.floor(remaining / 2);
        if (afford < 1) {
          res.message = "今月の予算上限に達したため、途中で停止しました";
          break;
        }
        const want = Math.min(size, afford);
        calls++;
        const page = await fetchPage(at.token, link.x_user_id, { max: want, token });
        if (!page.ok) {
          failure = page.message;
          if (page.code === "reauth") await markNeedsReauth(db, link.id, page.message);
          break;
        }
        const billedNow = page.posts.length + page.posts.filter((p) => p.quoted).length;
        res.billed += billedNow;
        remaining -= billedNow;
        res.fetched += page.posts.length;
        for (const p of page.posts) {
          if (topId === null) topId = p.id;
          if (!initial && link.newest_bookmark_id && p.id === link.newest_bookmark_id) {
            reachedKnown = true;
            break;
          }
          collected.push(p);
        }
        if (!page.nextToken || page.posts.length === 0 || initial) break;
        token = page.nextToken;
      }
      if (topId) newestId = topId;

      // 初回は直近の投稿だけ（過去の全ブックマークを取り込まない）
      const recent = initial ? collected.filter((p) => !p.createdAt || now.getTime() - new Date(p.createdAt).getTime() <= BOOKMARK_INITIAL_DAYS * 86_400_000) : collected;
      const known = await knownPostIds(db, householdId, recent);
      const rows: Record<string, unknown>[] = [];
      // 投稿ごとの処理状況（x_bookmark_posts）に記録する。取得できたことと、抽選として登録できたことは別の状態で持つ
      const track: { post: XPost; outcome: BookmarkOutcome; reason?: string }[] = [];
      for (const p of recent) {
        if (known.has(p.id)) {
          res.known++;
          track.push({ post: p, outcome: "known" });
          continue;
        }
        // ポケモンカードの抽選に関係しない投稿（他TCG・無関係な長文・古い投稿）は解析しない
        const j = judgeXPost({ text: p.text, images: p.images, links: p.links, createdAt: p.createdAt, quoted: p.quoted ?? null }, now);
        if (!j.pass) {
          res.irrelevant++;
          track.push({ post: p, outcome: "irrelevant" });
          continue;
        }
        track.push({ post: p, outcome: "queued" });
        const payload = { queued: { kind: "x_post", url: p.url, title: safeSlice(p.text, 80), context: "", sourceName: BOOKMARK_SOURCE_NAME, attempts: 0, listSeenAt: now.toISOString(), bookmark: true, post: { id: p.id, text: p.text, images: p.images, links: p.links, createdAt: p.createdAt, username: p.username ?? "", ...(p.authorId ? { authorId: p.authorId } : {}), ...(p.profile ? { profile: p.profile } : {}), ...(p.quoted ? { quoted: p.quoted } : {}) }, relevanceBasis: j.basis } };
        rows.push({ household_id: householdId, source_id: null, dedupe_key: `x:${p.id}`, source_url: p.url, x_post_id: p.id, title: safeSlice(p.text.replace(/\n/g, " "), 80) || p.url, status: "pending", job_state: "pending", reasons: ["解析待ち（Xブックマーク）"], draft: payload, last_checked_at: now.toISOString() });
      }
      const saved = await saveCandidateRows(db, rows);
      res.added = saved.saved;
      if (saved.failed > 0) failure = `候補の保存に失敗した投稿が${saved.failed}件あります`;
      // 候補の保存に失敗した投稿は「未取得」（解析待ちとは区別。次回の同期で再び候補にできる）
      await recordBookmarkPosts(db, householdId, track, now).catch(() => 0);
      await refreshBookmarkStates(db, householdId, now).catch(() => 0);
    }
  } finally {
    // 利用量の記録（既存の月額集計 collection_runs.x_posts に含まれる）。読み取りが無かった呼び出しは記録しない
    if (calls > 0) {
      await db.from("collection_runs").insert({ household_id: householdId, trigger: deps.trigger, phase: "bookmark", status: "done", started_at: now.toISOString(), finished_at: new Date().toISOString(), x_posts: res.billed, x_calls: calls, new_count: res.added, summary: [{ source: BOOKMARK_SOURCE_NAME, fetched: res.fetched, known: res.known, irrelevant: res.irrelevant, added: res.added }] } as never);
    }
    const line = failure ? "" : `読み取り${res.fetched}件・新しい候補${res.added}件（既知${res.known}件・対象外${res.irrelevant}件）`;
    await tbl(db, "x_bookmark_links")
      .update({
        lease_until: null,
        updated_at: new Date().toISOString(),
        ...(failure ? { last_error: failure.slice(0, 300) } : { last_error: "", last_synced_at: now.toISOString(), initial_synced_at: link.initial_synced_at ?? now.toISOString(), newest_bookmark_id: newestId, last_sync_result: line }),
      })
      .eq("id", link.id);
    if (failure) await releaseLease(db, link.id);
  }
  if (failure) return { ...res, ok: false, message: failure };
  return { ...res, message: res.message || `読み取り${res.fetched}件・新しい候補${res.added}件` };
}

/** 定期ワーカーから: 自動同期がONで、前回から最小間隔が過ぎた連携だけを同期する（OFFが初期値。1回の呼び出しで最大2件） */
export async function runBookmarkCron(db: Db, now = new Date(), deps: Partial<BookmarkSyncDeps> = {}): Promise<{ synced: number; skipped: number }> {
  if (!oauthConfig() && deps.cfg === undefined) return { synced: 0, skipped: 0 };
  const since = new Date(now.getTime() - BOOKMARK_MIN_INTERVAL_MS).toISOString();
  const { data } = await tbl(db, "x_bookmark_links").select("household_id").eq("auto_sync", true).eq("status", "active").or(`last_synced_at.is.null,last_synced_at.lt.${since}`).limit(2);
  let synced = 0;
  for (const l of (data ?? []) as { household_id: string }[]) {
    const r = await runBookmarkSync({ ...deps, db, householdId: l.household_id, trigger: "cron", now }).catch(() => null);
    if (r?.ok) synced++;
  }
  return { synced, skipped: ((data ?? []) as unknown[]).length - synced };
}
