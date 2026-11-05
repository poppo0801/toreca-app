/**
 * X OAuth 2.0（Authorization Code Flow + PKCE）の純関数（Stage 6I）。ネットワーク・DBには触れない。
 * トークンの暗号化は AES-256-GCM（鍵は環境変数 X_OAUTH_ENCRYPTION_KEY。base64の32バイト）。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_OAUTH_SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"] as const;
export const REQUIRED_SCOPES = ["tweet.read", "users.read", "bookmark.read"] as const;
export const DEFAULT_REDIRECT_URI = "https://toreca-app.vercel.app/api/x/oauth/callback";
export const STATE_TTL_MS = 10 * 60_000;

const b64url = (b: Buffer) => b.toString("base64url");

export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));
/** PKCE: code_verifier は 43〜128文字。challenge = BASE64URL(SHA256(verifier))（S256） */
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());
/** state は DB には SHA-256 のハッシュだけを保存する */
export const hashState = (state: string) => createHash("sha256").update(state).digest("hex");

export function buildAuthorizeUrl(o: { clientId: string; redirectUri: string; state: string; verifier: string }): string {
  const u = new URL(X_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("scope", X_OAUTH_SCOPES.join(" "));
  u.searchParams.set("state", o.state);
  u.searchParams.set("code_challenge", pkceChallenge(o.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** コールバックURL: 環境変数があればそれ、なければ本番の既定値。https のみ許可（開発の localhost は http も可） */
export function resolveRedirectUri(env: string | undefined): string {
  const v = env?.trim();
  if (!v) return DEFAULT_REDIRECT_URI;
  try {
    const u = new URL(v);
    if (u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return u.toString();
  } catch {
    /* 不正な値は既定値へ */
  }
  return DEFAULT_REDIRECT_URI;
}

// ---------------------------------------------------------------- 暗号化（AES-256-GCM）
function keyOf(raw: string | undefined): Buffer {
  const v = (raw ?? "").trim();
  // base64（32バイト）のほか、16進64文字（openssl rand -hex 32）も受け付ける
  const k = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (k.length !== 32) throw new Error("X_OAUTH_ENCRYPTION_KEY が未設定、または32バイト（base64／16進64文字）ではありません");
  return k;
}
export const hasEncryptionKey = (raw: string | undefined) => {
  try {
    keyOf(raw);
    return true;
  } catch {
    return false;
  }
};
export function encryptSecret(plain: string, rawKey: string | undefined): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(rawKey), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${b64url(iv)}.${b64url(c.getAuthTag())}.${b64url(ct)}`;
}
export function decryptSecret(token: string, rawKey: string | undefined): string {
  const [v, iv, tag, ct] = token.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("暗号化形式が不正です");
  const d = createDecipheriv("aes-256-gcm", keyOf(rawKey), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

// ---------------------------------------------------------------- トークン応答
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}
export type TokenParse = { ok: true; tokens: TokenSet } | { ok: false; code: "invalid_grant" | "invalid_client" | "error"; message: string };

/** トークンエンドポイントの応答を解釈する。応答の中身（トークン）はエラー文言に含めない */
export function parseTokenResponse(status: number, json: unknown, now: Date, prevRefresh = ""): TokenParse {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && typeof j.access_token === "string" && j.access_token) {
    const ttl = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 7200;
    return {
      ok: true,
      tokens: {
        accessToken: j.access_token,
        // 更新トークンは使うたびに新しいものが返る（古いものは無効）。返らなければ従来のものを使う
        refreshToken: typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : prevRefresh,
        expiresAt: new Date(now.getTime() + ttl * 1000),
        scopes: typeof j.scope === "string" ? j.scope.split(/\s+/).filter(Boolean) : [],
      },
    };
  }
  const err = typeof j.error === "string" ? j.error : "";
  if (err === "invalid_grant") return { ok: false, code: "invalid_grant", message: "Xの認証が無効になりました（取り消し・期限切れ）。再連携してください" };
  if (err === "invalid_client" || status === 401) return { ok: false, code: "invalid_client", message: "X連携のクライアント設定（Client ID / Secret）が正しくありません" };
  return { ok: false, code: "error", message: `Xの認証サーバーがエラーを返しました（${status}）` };
}

export const missingScopes = (granted: string[]) => REQUIRED_SCOPES.filter((s) => !granted.includes(s));

/** アクセストークンの更新が必要か（期限の2分前から更新する） */
export const needsRefresh = (expiresAt: Date, now: Date) => expiresAt.getTime() - now.getTime() < 2 * 60_000;
