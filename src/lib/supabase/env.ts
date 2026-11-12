import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { isSupabaseUrl } from "@/lib/supabase/url";
import { classifyTarget, isLocalSupabaseUrl } from "@/lib/supabase/target";

/** データ源。mock=ローカルモック（認証なし）/ supabase=Supabase認証＋DB（本番ビルドの既定） */
export const isSupabaseMode = IS_SUPABASE_MODE;

/**
 * 開発・テスト環境か。`next dev`、またはローカル用の設定（.env.local の TOREMANE_ENV=local）。
 * Vercel の本番には設定しない（設定しても 127.0.0.1 には届かないので本番に影響しない）。
 */
function isDevTarget(): boolean {
  return process.env.NODE_ENV === "development" || process.env.TOREMANE_ENV === "local";
}

export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY が未設定です（.env.local）");
  }
  // Stage 8C: 開発・テスト環境は、本番の Supabase に繋がない（鍵も含めて判定。解除手段は設けない）
  if (isDevTarget() && classifyTarget(url, key, process.env.SUPABASE_SERVICE_ROLE_KEY) === "production") {
    throw new Error("開発環境から本番の Supabase には接続できません。ローカルの開発用DBを使ってください（npm run db:up / docs/DEV_ENVIRONMENT.md）");
  }
  // ローカルの Supabase（http://127.0.0.1）は開発・テスト環境でのみ許可。本番ビルドでは従来どおり公式ホストのみ
  if (!isSupabaseUrl(url) && !(isDevTarget() && isLocalSupabaseUrl(url))) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL が Supabase のURL（https://<プロジェクトID>.supabase.co）ではありません");
  }
  return { url: url.trim().replace(/\/$/, ""), key: key.trim() };
}
