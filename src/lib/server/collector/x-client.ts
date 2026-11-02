import "server-only";
import { classifyXError, parseXPosts, type XApiErrorCode, type XPost } from "@/lib/collector/x-posts";
import { sniffImage } from "@/lib/server/image-sniff";

/**
 * X公式API(v2)クライアント。Bearerトークンはサーバー側の環境変数 X_BEARER_TOKEN からのみ読み、ログ・応答には出さない。
 * 接続先は api.x.com に固定（利用者の入力するURLは使わない）。ログイン回避・非公式APIは使わない。
 * 呼び出しの前に、利用予算の確認を必ず行うこと（呼び出し側 run.ts の責務）。
 */

const BASE = "https://api.x.com/2";

export type XResult<T> = ({ ok: true } & T) | { ok: false; code: XApiErrorCode; message: string };

export interface XClient {
  lookupUser(username: string): Promise<XResult<{ id: string; username: string }>>;
  userPosts(userId: string, username: string, opts: { sinceId?: string | null; max: number }): Promise<XResult<{ posts: XPost[]; newestId: string | null }>>;
  /** 投稿URLから投稿を1件取得する（単件・一括・共有の解析用。取得した投稿1件ぶんの従量課金） */
  getPost(id: string, username: string): Promise<XResult<{ post: XPost }>>;
}

export function createXClient(token: string | undefined = process.env.X_BEARER_TOKEN): XClient | null {
  const t = token?.trim();
  if (!t) return null;

  async function get(path: string, params: Record<string, string>): Promise<{ ok: true; json: unknown } | { ok: false; code: XApiErrorCode; message: string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${t}`, Accept: "application/json" }, signal: ctl.signal, redirect: "error", cache: "no-store" });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (!res.ok) return { ok: false, ...classifyXError(res.status, json) };
      return { ok: true, json };
    } catch {
      return { ok: false, code: "network", message: "X APIに接続できませんでした" };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async lookupUser(username) {
      const r = await get(`/users/by/username/${encodeURIComponent(username)}`, { "user.fields": "id,username" });
      if (!r.ok) return r;
      const d = (r.json as { data?: { id?: unknown; username?: unknown }; errors?: { title?: unknown; detail?: unknown }[] }) ?? {};
      if (typeof d.data?.id === "string" && /^\d{1,25}$/.test(d.data.id)) return { ok: true, id: d.data.id, username: typeof d.data.username === "string" ? d.data.username : username };
      const why = String(d.errors?.[0]?.detail ?? "").slice(0, 120);
      return { ok: false, code: /suspended/i.test(why) ? "suspended" : "not_found", message: `アカウントを取得できませんでした${why ? `（${why}）` : ""}` };
    },
    async getPost(id, username) {
      const r = await get(`/tweets/${encodeURIComponent(id)}`, {
        "tweet.fields": "created_at,entities,attachments,referenced_tweets,author_id",
        expansions: "attachments.media_keys",
        "media.fields": "type,url",
      });
      if (!r.ok) return r;
      const j = r.json as { data?: unknown; includes?: unknown };
      const posts = parseXPosts({ data: j.data ? [j.data] : [], includes: j.includes }, username);
      return posts[0] ? { ok: true, post: posts[0] } : { ok: false, code: "not_found", message: "投稿を取得できませんでした（削除・非公開の可能性）" };
    },
    async userPosts(userId, username, opts) {
      const params: Record<string, string> = {
        max_results: String(Math.min(100, Math.max(5, opts.max))),
        "tweet.fields": "created_at,entities,attachments,referenced_tweets,author_id",
        expansions: "attachments.media_keys",
        "media.fields": "type,url",
        exclude: "retweets,replies",
      };
      if (opts.sinceId) params.since_id = opts.sinceId;
      const r = await get(`/users/${encodeURIComponent(userId)}/tweets`, params);
      if (!r.ok) return r;
      const posts = parseXPosts(r.json, username);
      const newest = (r.json as { meta?: { newest_id?: unknown } })?.meta?.newest_id;
      return { ok: true, posts, newestId: typeof newest === "string" && /^\d{1,25}$/.test(newest) ? newest : null };
    },
  };
}

/** 投稿に添付された画像の取得。接続先は pbs.twimg.com（Xの画像配信）に固定し、リダイレクト・大きなファイルは拒否する */
export async function fetchXImage(url: string): Promise<{ mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; base64: string; bytes: number } | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "pbs.twimg.com" || u.username || u.password) return null;
  u.searchParams.set("name", "large");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(u, { signal: ctl.signal, redirect: "error", cache: "no-store" });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > 3_000_000) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 3_000_000) return null;
    const mediaType = sniffImage(buf);
    return mediaType ? { mediaType, base64: buf.toString("base64"), bytes: buf.length } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
