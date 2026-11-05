import { describe, expect, it } from "vitest";
import { DEFAULT_REDIRECT_URI, REQUIRED_SCOPES, X_OAUTH_SCOPES, buildAuthorizeUrl, decryptSecret, encryptSecret, hasEncryptionKey, hashState, missingScopes, needsRefresh, parseTokenResponse, pkceChallenge, randomToken, resolveRedirectUri } from "@/lib/x-oauth";

const KEY = Buffer.alloc(32, 7).toString("base64");
const NOW = new Date("2026-11-05T00:00:00Z");

describe("Stage 6I: OAuth 2.0 (PKCE)", () => {
  it("PKCE の challenge は RFC 7636 の例と一致する（S256）", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("state / verifier は毎回異なる十分な長さのランダム値。stateはハッシュで保存する", () => {
    const a = randomToken(32);
    expect(a).not.toBe(randomToken(32));
    expect(randomToken(48).length).toBeGreaterThanOrEqual(43);
    expect(hashState(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashState(a)).not.toContain(a);
  });
  it("認可URL: 必要な4つの権限・S256・state・コールバックを含み、verifier自体は含まない", () => {
    const u = new URL(buildAuthorizeUrl({ clientId: "cid", redirectUri: DEFAULT_REDIRECT_URI, state: "st", verifier: "v".repeat(50) }));
    expect(u.origin + u.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")?.split(" ")).toEqual(["tweet.read", "users.read", "bookmark.read", "offline.access"]);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(pkceChallenge("v".repeat(50)));
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("redirect_uri")).toBe("https://toreca-app.vercel.app/api/x/oauth/callback");
    expect(u.toString()).not.toContain("v".repeat(50));
    expect(X_OAUTH_SCOPES).toContain("offline.access");
  });
  it("コールバックURL: 既定は本番。https以外・不正値は既定へ戻す（localhostのhttpは可）", () => {
    expect(resolveRedirectUri(undefined)).toBe(DEFAULT_REDIRECT_URI);
    expect(resolveRedirectUri("http://evil.example/cb")).toBe(DEFAULT_REDIRECT_URI);
    expect(resolveRedirectUri("not a url")).toBe(DEFAULT_REDIRECT_URI);
    expect(resolveRedirectUri("https://toreca-app.vercel.app/api/x/oauth/callback")).toBe(DEFAULT_REDIRECT_URI);
    expect(resolveRedirectUri("http://localhost:3000/api/x/oauth/callback")).toContain("localhost:3000");
  });
});

describe("Stage 6I: トークンの暗号化（AES-256-GCM）", () => {
  it("暗号化して復号できる。保存形式に平文を含まず、毎回異なる", () => {
    const plain = "access-token-ABC123";
    const a = encryptSecret(plain, KEY);
    expect(a).toMatch(/^v1\./);
    expect(a).not.toContain(plain);
    expect(encryptSecret(plain, KEY)).not.toBe(a);
    expect(decryptSecret(a, KEY)).toBe(plain);
  });
  it("改ざん・別の鍵・不正な形式は復号できない", () => {
    const a = encryptSecret("secret", KEY);
    const parts = a.split(".");
    const bad = [parts[0], parts[1], parts[2], `${parts[3].slice(0, -2)}AA`].join(".");
    expect(() => decryptSecret(bad, KEY)).toThrow();
    expect(() => decryptSecret(a, Buffer.alloc(32, 9).toString("base64"))).toThrow();
    expect(() => decryptSecret("garbage", KEY)).toThrow();
  });
  it("鍵が未設定・長さ不正なら暗号化しない（平文で保存しない）", () => {
    expect(hasEncryptionKey(KEY)).toBe(true);
    expect(hasEncryptionKey(undefined)).toBe(false);
    expect(hasEncryptionKey("short")).toBe(false);
    expect(() => encryptSecret("x", undefined)).toThrow();
  });
});

describe("Stage 6I: トークン応答・更新・認証エラー", () => {
  it("成功: 期限・権限を読む。更新トークンが返ればそれを使い、返らなければ従来のものを使う", () => {
    const ok = parseTokenResponse(200, { access_token: "a", refresh_token: "r2", expires_in: 7200, scope: "tweet.read users.read bookmark.read offline.access" }, NOW, "r1");
    expect(ok.ok && ok.tokens.refreshToken).toBe("r2");
    expect(ok.ok && ok.tokens.expiresAt.toISOString()).toBe("2026-11-05T02:00:00.000Z");
    expect(ok.ok && missingScopes(ok.tokens.scopes)).toEqual([]);
    const keep = parseTokenResponse(200, { access_token: "a", expires_in: 100 }, NOW, "r1");
    expect(keep.ok && keep.tokens.refreshToken).toBe("r1");
  });
  it("invalid_grant は再連携が必要。クライアント設定の誤り・その他は区別し、エラー文言にトークンを含めない", () => {
    const g = parseTokenResponse(400, { error: "invalid_grant", error_description: "Value passed for the token was invalid. refresh-secret-xyz" }, NOW);
    expect(g).toMatchObject({ ok: false, code: "invalid_grant" });
    expect(JSON.stringify(g)).not.toContain("refresh-secret-xyz");
    expect(parseTokenResponse(401, { error: "invalid_client" }, NOW)).toMatchObject({ ok: false, code: "invalid_client" });
    expect(parseTokenResponse(500, null, NOW)).toMatchObject({ ok: false, code: "error" });
    expect(parseTokenResponse(200, {}, NOW)).toMatchObject({ ok: false });
  });
  it("権限不足を検出する。期限の2分前から更新が必要", () => {
    expect(missingScopes(["tweet.read", "users.read"])).toEqual(["bookmark.read"]);
    expect([...REQUIRED_SCOPES]).not.toContain("offline.access");
    expect(needsRefresh(new Date(NOW.getTime() + 60_000), NOW)).toBe(true);
    expect(needsRefresh(new Date(NOW.getTime() + 600_000), NOW)).toBe(false);
  });
});

describe("Stage 6I: 暗号化キーの形式", () => {
  it("16進64文字も使える。短い・不正な値は拒否する", () => {
    const hex = "ab".repeat(32);
    expect(hasEncryptionKey(hex)).toBe(true);
    expect(decryptSecret(encryptSecret("s", hex), hex)).toBe("s");
    expect(hasEncryptionKey("ab".repeat(16))).toBe(false);
  });
});
