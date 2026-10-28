import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SplashScreen } from "@/components/splash-screen";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

/**
 * 認証が必要な画面はすべてリクエストごとに描画する（ビルド時に静的生成しない）。
 * 環境変数の設定ミスがあってもビルドは通り、実行時に明確なエラーとして現れる。
 */
export const dynamic = "force-dynamic";

/** ログイン確認と世帯の準備（DBへの問い合わせ）。完了するまでの間は Suspense のロード画面が表示される */
async function AuthGate({ children }: { children: React.ReactNode }) {
  if (isSupabaseMode) {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) redirect("/login");
    // 世帯が未作成なら作る（冪等）。以降のクエリはRLSで自世帯のみ。
    await supabase.rpc("bootstrap_household");
    // 応募名義はユーザー(プロフィール)ごとに1つ。系列ごとの内部アカウントを自動で保証する（画面での管理は不要）
    await supabase.rpc("ensure_profile_accounts");
  }
  return <AppShell>{children}</AppShell>;
}

/**
 * 起動時は、認証確認が終わるのを待たずに最初にロード画面のHTMLを返す（ストリーミング）。
 * 以降のページ移動ではこのレイアウトは再描画されないので、ロード画面は起動・再読み込みのときだけ出る。
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<SplashScreen />}>
      <AuthGate>{children}</AuthGate>
    </Suspense>
  );
}
