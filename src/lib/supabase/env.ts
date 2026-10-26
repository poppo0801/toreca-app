/** データ源。mock=Stage 0のローカルモック（認証なし）/ supabase=Supabase認証＋DB */
export const isSupabaseMode = process.env.NEXT_PUBLIC_DATA_SOURCE === "supabase";

export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY が未設定です（.env.local）");
  }
  return { url, key };
}
