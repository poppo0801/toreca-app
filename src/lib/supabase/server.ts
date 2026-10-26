import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { hardenCookie } from "@/lib/supabase/cookies";
import { supabaseEnv } from "@/lib/supabase/env";

/**
 * サーバー(Server Component/Action)用クライアント。publishableキー＋ログインユーザーのJWTで動作し、RLSが適用される。
 * service_role キーはアプリコードでは使用しない（テスト/バックアップスクリプトのみ）。
 */
export async function createClient() {
  const { url, key } = supabaseEnv();
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(list) {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, hardenCookie(options)));
        } catch {
          /* Server Component からの呼び出し時は無視（proxy でセッション更新済み） */
        }
      },
    },
  });
}
