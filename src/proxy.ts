import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { hardenCookie } from "@/lib/supabase/cookies";
import { safeNext } from "@/lib/share-intake";

/**
 * 認証ガード（Supabaseモード時のみ）。未ログインは /login へ。セッションCookieもここで更新する。
 * 実際の認可は各クエリのRLSが担う（これは画面への導線制御）。
 */
export async function proxy(request: NextRequest) {
  if (!IS_SUPABASE_MODE) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(list) {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, hardenCookie(options)));
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const loggedIn = !!data?.claims;
  const isLogin = request.nextUrl.pathname === "/login";

  if (!loggedIn && !isLogin) {
    // iPhoneの共有（/share）だけは、ログイン後に元の共有へ戻れるよう行き先を渡す
    const back = request.nextUrl.pathname === "/share" ? safeNext(request.nextUrl.pathname + request.nextUrl.search) : null;
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = back && back !== "/lotteries" ? `?next=${encodeURIComponent(back)}` : "";
    return NextResponse.redirect(url);
  }
  if (loggedIn && isLogin) {
    // ログイン済みで /login?next=/share... を開いた場合は共有へ進む
    const to = safeNext(request.nextUrl.searchParams.get("next"));
    return NextResponse.redirect(new URL(to, request.nextUrl.origin));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/cron/|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|js|webmanifest)$).*)"],
};
