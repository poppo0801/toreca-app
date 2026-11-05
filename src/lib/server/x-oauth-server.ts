import "server-only";
import { createClient } from "@supabase/supabase-js";
import { X_API_BASE } from "@/lib/server/collector/x-client";
import { STATE_TTL_MS, X_TOKEN_URL, buildAuthorizeUrl, decryptSecret, encryptSecret, hasEncryptionKey, hashState, missingScopes, needsRefresh, parseTokenResponse, randomToken, resolveRedirectUri, type TokenParse, type TokenSet } from "@/lib/x-oauth";
import type { Db } from "@/lib/server/lottery-service";

/**
 * X連携（OAuth 2.0 + PKCE）のサーバー処理（Stage 6I）。
 * アクセストークン・更新トークンは暗号化して x_oauth_tokens にだけ保存し（利用者からは読めない）、画面・ログ・エラー文言には出さない。
 * 新しい表は生成型に無いため、最小限の型で扱う。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
type Loose = { from: (t: string) => any };
const t = (db: Db) => db as unknown as Loose;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encKey: string;
}

export function oauthConfig(env: Record<string, string | undefined> = process.env): OAuthConfig | null {
  const clientId = env.X_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.X_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || !hasEncryptionKey(env.X_OAUTH_ENCRYPTION_KEY)) return null;
  return { clientId, clientSecret, redirectUri: resolveRedirectUri(env.X_OAUTH_REDIRECT_URI), encKey: env.X_OAUTH_ENCRYPTION_KEY!.trim() };
}

/** 設定画面に出す、環境変数の設定状況（値は出さない） */
export function oauthConfigStatus(env: Record<string, string | undefined> = process.env) {
  return { clientId: !!env.X_OAUTH_CLIENT_ID?.trim(), clientSecret: !!env.X_OAUTH_CLIENT_SECRET?.trim(), encryptionKey: hasEncryptionKey(env.X_OAUTH_ENCRYPTION_KEY), redirectUri: resolveRedirectUri(env.X_OAUTH_REDIRECT_URI) };
}

export function adminDb(): Db | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db;
}

// ---------------------------------------------------------------- トークンエンドポイント
async function tokenCall(cfg: OAuthConfig, path: string, body: Record<string, string>, now: Date, prevRefresh = ""): Promise<TokenParse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}` },
      body: new URLSearchParams(body),
      signal: ctl.signal,
      redirect: "error",
      cache: "no-store",
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return parseTokenResponse(res.status, json, now, prevRefresh);
  } catch {
    return { ok: false, code: "error", message: "Xの認証サーバーに接続できませんでした" };
  } finally {
    clearTimeout(timer);
  }
}

export const exchangeCode = (cfg: OAuthConfig, code: string, verifier: string, now = new Date()) =>
  tokenCall(cfg, X_TOKEN_URL, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier, client_id: cfg.clientId }, now);

export const refreshTokens = (cfg: OAuthConfig, refreshToken: string, now = new Date()) =>
  tokenCall(cfg, X_TOKEN_URL, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId }, now, refreshToken);

/** 連携したアカウント(自分)のID・ユーザー名 */
export async function fetchMe(accessToken: string): Promise<{ ok: true; id: string; username: string } | { ok: false; message: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(`${X_API_BASE}/users/me?user.fields=username`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, signal: ctl.signal, redirect: "error", cache: "no-store" });
    const j = (await res.json().catch(() => null)) as { data?: { id?: unknown; username?: unknown } } | null;
    const id = j?.data?.id;
    const username = j?.data?.username;
    if (res.ok && typeof id === "string" && /^[0-9]{1,25}$/.test(id) && typeof username === "string" && /^[A-Za-z0-9_]{1,15}$/.test(username)) return { ok: true, id, username };
    return { ok: false, message: res.status === 401 ? "Xの認証に失敗しました" : `連携したアカウントの情報を取得できませんでした（${res.status}）` };
  } catch {
    return { ok: false, message: "X APIに接続できませんでした" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 認証の開始・完了
/** 認証を開始する。state(CSRF対策)と PKCE の code_verifier を作り、DBに保存（10分・1回限り）して、認可URLを返す */
export async function startOAuth(db: Db, cfg: OAuthConfig, o: { householdId: string; userId: string; now?: Date }): Promise<{ url: string; state: string } | null> {
  const now = o.now ?? new Date();
  const state = randomToken(32);
  const verifier = randomToken(48);
  await t(db).from("x_oauth_states").delete().lt("expires_at", now.toISOString());
  const { error } = await t(db).from("x_oauth_states").insert({ state_hash: hashState(state), household_id: o.householdId, user_id: o.userId, verifier_enc: encryptSecret(verifier, cfg.encKey), expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString() });
  if (error) return null;
  return { url: buildAuthorizeUrl({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, state, verifier }), state };
}

/** state を1回だけ使えるように取り出して削除する。期限切れ・別ユーザー・存在しないものは失敗 */
export async function consumeState(db: Db, cfg: OAuthConfig, state: string, userId: string, now = new Date()): Promise<{ householdId: string; verifier: string } | null> {
  if (!state || state.length > 200) return null;
  const { data } = await t(db).from("x_oauth_states").delete().eq("state_hash", hashState(state)).select("household_id,user_id,verifier_enc,expires_at");
  const row = (data ?? [])[0] as { household_id: string; user_id: string; verifier_enc: string; expires_at: string } | undefined;
  if (!row || row.user_id !== userId || new Date(row.expires_at).getTime() < now.getTime()) return null;
  try {
    return { householdId: row.household_id, verifier: decryptSecret(row.verifier_enc, cfg.encKey) };
  } catch {
    return null;
  }
}

async function saveTokens(db: Db, cfg: OAuthConfig, linkId: string, tk: TokenSet, now: Date): Promise<boolean> {
  const { error } = await t(db).from("x_oauth_tokens").upsert({ link_id: linkId, access_token_enc: encryptSecret(tk.accessToken, cfg.encKey), refresh_token_enc: tk.refreshToken ? encryptSecret(tk.refreshToken, cfg.encKey) : "", expires_at: tk.expiresAt.toISOString(), updated_at: now.toISOString() }, { onConflict: "link_id" });
  return !error;
}

export type CompleteResult = { ok: true; username: string } | { ok: false; message: string };

/** 認可コードをトークンに交換し、連携を保存する。連携しただけでは自動同期はONにしない。別アカウントへの付け替えでは同期位置をリセットする */
export async function completeOAuth(db: Db, cfg: OAuthConfig, o: { code: string; verifier: string; householdId: string; userId: string; now?: Date }): Promise<CompleteResult> {
  const now = o.now ?? new Date();
  const tk = await exchangeCode(cfg, o.code, o.verifier, now);
  if (!tk.ok) return { ok: false, message: tk.message };
  const miss = missingScopes(tk.tokens.scopes);
  if (miss.length > 0 && tk.tokens.scopes.length > 0) return { ok: false, message: `必要な権限が許可されていません（${miss.join("・")}）` };
  const me = await fetchMe(tk.tokens.accessToken);
  if (!me.ok) return { ok: false, message: me.message };
  const cur = (await t(db).from("x_bookmark_links").select("id,x_user_id").eq("household_id", o.householdId).maybeSingle()).data as { id: string; x_user_id: string } | null;
  const base = { x_user_id: me.id, x_username: me.username, scopes: tk.tokens.scopes, status: "active", last_error: "", connected_by: o.userId, updated_at: now.toISOString() };
  let linkId = cur?.id ?? "";
  if (cur) {
    const reset = cur.x_user_id !== me.id ? { auto_sync: false, initial_synced_at: null, newest_bookmark_id: null, last_synced_at: null, last_sync_result: "" } : {};
    const { error } = await t(db).from("x_bookmark_links").update({ ...base, ...reset, lease_until: null }).eq("id", cur.id);
    if (error) return { ok: false, message: "連携を保存できませんでした" };
  } else {
    const { data, error } = await t(db).from("x_bookmark_links").insert({ household_id: o.householdId, ...base, auto_sync: false }).select("id").single();
    if (error || !data) return { ok: false, message: "連携を保存できませんでした" };
    linkId = (data as { id: string }).id;
  }
  if (!(await saveTokens(db, cfg, linkId, tk.tokens, now))) return { ok: false, message: "認証情報を保存できませんでした" };
  return { ok: true, username: me.username };
}

// ---------------------------------------------------------------- アクセストークンの取得（期限が近ければ更新）
export interface LinkRow {
  id: string;
  household_id: string;
  x_user_id: string;
  x_username: string;
  auto_sync: boolean;
  status: "active" | "needs_reauth";
  last_synced_at: string | null;
  initial_synced_at: string | null;
  newest_bookmark_id: string | null;
}
export const LINK_COLS = "id,household_id,x_user_id,x_username,auto_sync,status,last_synced_at,initial_synced_at,newest_bookmark_id";

export async function loadLink(db: Db, householdId: string): Promise<LinkRow | null> {
  const { data } = await t(db).from("x_bookmark_links").select(LINK_COLS).eq("household_id", householdId).maybeSingle();
  return (data as LinkRow | null) ?? null;
}

/** 認証が使えなくなった連携を「再連携が必要」にし、自動同期を止める（応募・購入・メモ・候補には触れない） */
export async function markNeedsReauth(db: Db, linkId: string, message: string): Promise<void> {
  await t(db).from("x_bookmark_links").update({ status: "needs_reauth", auto_sync: false, last_error: message.slice(0, 300), updated_at: new Date().toISOString() }).eq("id", linkId);
}

export type AccessResult = { ok: true; token: string } | { ok: false; message: string; reauth: boolean };

/**
 * 有効なアクセストークンを返す。期限が近ければ更新トークンで更新し、新しいトークンを保存する
 * （更新トークンは1回しか使えないため、同期の貸出(lease)を取った呼び出しからだけ呼ぶこと）。
 */
export async function getAccessToken(db: Db, cfg: OAuthConfig, link: Pick<LinkRow, "id">, now = new Date()): Promise<AccessResult> {
  const { data } = await t(db).from("x_oauth_tokens").select("access_token_enc,refresh_token_enc,expires_at").eq("link_id", link.id).maybeSingle();
  const row = data as { access_token_enc: string; refresh_token_enc: string; expires_at: string } | null;
  if (!row) {
    await markNeedsReauth(db, link.id, "認証情報がありません。再連携してください");
    return { ok: false, message: "認証情報がありません。再連携してください", reauth: true };
  }
  let access: string;
  let refresh: string;
  try {
    access = decryptSecret(row.access_token_enc, cfg.encKey);
    refresh = row.refresh_token_enc ? decryptSecret(row.refresh_token_enc, cfg.encKey) : "";
  } catch {
    await markNeedsReauth(db, link.id, "認証情報を復号できません。再連携してください");
    return { ok: false, message: "認証情報を復号できません。再連携してください", reauth: true };
  }
  if (!needsRefresh(new Date(row.expires_at), now)) return { ok: true, token: access };
  if (!refresh) {
    await markNeedsReauth(db, link.id, "認証の期限が切れました。再連携してください");
    return { ok: false, message: "認証の期限が切れました。再連携してください", reauth: true };
  }
  const r = await refreshTokens(cfg, refresh, now);
  if (!r.ok) {
    // 取り消し・無効は再連携が必要。通信などの一時的な失敗は、状態を変えずに次回へ回す
    if (r.code === "invalid_grant") await markNeedsReauth(db, link.id, r.message);
    return { ok: false, message: r.message, reauth: r.code === "invalid_grant" };
  }
  if (!(await saveTokens(db, cfg, link.id, r.tokens, now))) return { ok: false, message: "更新した認証情報を保存できませんでした", reauth: false };
  return { ok: true, token: r.tokens.accessToken };
}

// ---------------------------------------------------------------- 同期の貸出（多重実行・同時のトークン更新を防ぐ）
export async function acquireLease(db: Db, linkId: string, now = new Date(), ttlMs = 3 * 60_000): Promise<boolean> {
  const { data } = await t(db)
    .from("x_bookmark_links")
    .update({ lease_until: new Date(now.getTime() + ttlMs).toISOString() })
    .eq("id", linkId)
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("id");
  return ((data ?? []) as unknown[]).length === 1;
}
export const releaseLease = async (db: Db, linkId: string) => void (await t(db).from("x_bookmark_links").update({ lease_until: null }).eq("id", linkId));

// ---------------------------------------------------------------- 連携解除
/** 連携を解除する: Xのトークンを失効させ（できなければ破棄のみ）、連携とトークンを削除する。収集済みの候補・抽選・応募・購入・メモは変更しない */
export async function disconnect(db: Db, cfg: OAuthConfig | null, householdId: string): Promise<{ ok: boolean; revoked: boolean }> {
  const link = await loadLink(db, householdId);
  if (!link) return { ok: true, revoked: false };
  let revoked = false;
  if (cfg) {
    try {
      const { data } = await t(db).from("x_oauth_tokens").select("access_token_enc").eq("link_id", link.id).maybeSingle();
      const enc = (data as { access_token_enc?: string } | null)?.access_token_enc;
      if (enc) {
        const res = await fetch(`${X_API_BASE}/oauth2/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}` },
          body: new URLSearchParams({ token: decryptSecret(enc, cfg.encKey), token_type_hint: "access_token", client_id: cfg.clientId }),
          signal: AbortSignal.timeout(8000),
          redirect: "error",
          cache: "no-store",
        });
        revoked = res.ok;
      }
    } catch {
      revoked = false; // 失効に失敗しても、こちらの保存は削除する
    }
  }
  const { error } = await t(db).from("x_bookmark_links").delete().eq("id", link.id);
  return { ok: !error, revoked };
}
