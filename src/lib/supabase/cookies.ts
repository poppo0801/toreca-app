import type { CookieOptions } from "@supabase/ssr";

/**
 * セッションCookieの強化。このアプリはブラウザ側のSupabaseクライアントを使わず、認証はすべてサーバーで行うため、
 * JavaScriptから読めない(httpOnly)・HTTPSのみ(secure)・CSRF緩和(sameSite=lax)にして盗用リスクを下げる。
 */
export function hardenCookie(options: CookieOptions | undefined): CookieOptions {
  return {
    ...options,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: options?.path ?? "/",
  };
}
