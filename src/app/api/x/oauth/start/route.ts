import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { adminDb, oauthConfig, startOAuth } from "@/lib/server/x-oauth-server";
import { currentHouseholdId } from "@/lib/server/lottery-service";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "x_oauth_state";

/**
 * Xアカウント連携の開始（OAuth 2.0 Authorization Code Flow + PKCE）。ログイン必須。
 * state と code_verifier はサーバーで作り、DBに10分・1回限りで保存する。state は同じブラウザのCookie(httpOnly)にも持たせ、
 * コールバックで「Cookie・DB・ログイン中のユーザー」の三者が一致したときだけ受け付ける（CSRF・ログインCSRF対策）。
 */
export async function GET(req: NextRequest) {
  const back = (q: string) => NextResponse.redirect(new URL(`/settings/x-link?${q}`, req.url));
  if (!isSupabaseMode) return back("x=config");
  const cfg = oauthConfig();
  const admin = adminDb();
  if (!cfg || !admin) return back("x=config");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.redirect(new URL("/login", req.url));
  const householdId = await currentHouseholdId(supabase as never);
  if (!householdId) return back("x=failed");
  const started = await startOAuth(admin, cfg, { householdId, userId: auth.user.id });
  if (!started) return back("x=failed");
  const res = NextResponse.redirect(started.url);
  res.cookies.set(STATE_COOKIE, started.state, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/x/oauth", maxAge: 600 });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
