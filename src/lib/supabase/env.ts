import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { isSupabaseUrl } from "@/lib/supabase/url";

/** データ源。mock=ローカルモック（認証なし）/ supabase=Supabase認証＋DB（本番ビルドの既定） */
export const isSupabaseMode = IS_SUPABASE_MODE;

export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY が未設定です（.env.local）");
  }
  if (!isSupabaseUrl(url)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL が Supabase のURL（https://<プロジェクトID>.supabase.co）ではありません");
  }
  return { url: url.trim().replace(/\/$/, ""), key: key.trim() };
}
