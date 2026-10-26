/**
 * SupabaseのURL形式の検証。設定ミス（例: アプリ自身のURLや別サービスのURLを入れてしまう）を早期に検出する。
 * 公式のホスト（<project-ref>.supabase.co / .supabase.in）のみ許可する。
 */
export function isSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/.test(url.trim());
}
