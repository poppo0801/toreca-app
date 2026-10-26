/**
 * データ源の判定（クライアント・サーバー・proxy 共通。値はビルド時に埋め込まれる）。
 *  - NEXT_PUBLIC_DATA_SOURCE=supabase : ログイン必須＋DB保存
 *  - NEXT_PUBLIC_DATA_SOURCE=mock     : 認証なしの架空データ（開発・CI・E2E用。明示した場合のみ）
 *  - 未指定: 本番ビルドでは supabase（フェイルクローズ。設定漏れで認証なしの画面を公開しない）、開発・テストでは mock
 */
export const IS_SUPABASE_MODE: boolean = (() => {
  const v = process.env.NEXT_PUBLIC_DATA_SOURCE;
  if (v === "supabase") return true;
  if (v === "mock") return false;
  return process.env.NODE_ENV === "production";
})();
