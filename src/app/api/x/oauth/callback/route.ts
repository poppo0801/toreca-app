import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { adminDb, completeOAuth, consumeState, oauthConfig } from "@/lib/server/x-oauth-server";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "x_oauth_state";
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Xからのコールバック。state(Cookieと一致)・DBの1回限りのstate・ログイン中のユーザーが一致したときだけ、認可コードをトークンに交換する。
 * 成功しても自動同期はONにしない（設定画面で利用者がONにするまで、有料のX API取得は始まらない）。
 * 画面に返すのは結果の区分と、秘密を含まない短い文言だけ。
 */
export async function GET(req: NextRequest) {
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/settings/x-link?${q}`, req.url));
    res.cookies.set(STATE_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/x/oauth", maxAge: 0 });
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  if (!isSupabaseMode) return back("x=config");
  const sp = req.nextUrl.searchParams;
  if (sp.get("error")) return back(sp.get("error") === "access_denied" ? "x=denied" : "x=failed");
  const code = sp.get("code") ?? "";
  const state = sp.get("state") ?? "";
  const cookie = req.cookies.get(STATE_COOKIE)?.value ?? "";
  if (!code || !state || code.length > 2000 || !cookie || !same(cookie, state)) return back("x=invalid");
  const cfg = oauthConfig();
  const admin = adminDb();
  if (!cfg || !admin) return back("x=config");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.redirect(new URL("/login", req.url));
  const st = await consumeState(admin, cfg, state, auth.user.id);
  if (!st) return back("x=invalid");
  // 状態を作った世帯に、いまもこのユーザーが所属していること（RLS）
  const hh = await supabase.from("households").select("id").eq("id", st.householdId).maybeSingle();
  if (!hh.data) return back("x=invalid");
  const r = await completeOAuth(admin, cfg, { code, verifier: st.verifier, householdId: st.householdId, userId: auth.user.id });
  if (!r.ok) return back(`x=failed&m=${encodeURIComponent(r.message.slice(0, 80))}`);
  return back("x=ok");
}
