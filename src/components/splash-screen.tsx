import Link from "next/link";
import { LogoMark } from "@/components/brand-logo";
import { APP_NAME, APP_SUBTITLE } from "@/lib/brand";

/**
 * 起動時のロード画面（サーバーでもクライアントでも同じ見た目）。
 * 最初のHTMLに含まれるので、JavaScriptやデータの準備を待つ間も黒い画面にならない。背景・文字色はアプリのテーマ（ライト/ダーク）に従う。
 * 読み込みが終わったら通常画面に切り替わる（固定秒数は表示しない）。失敗時は error を渡し、再試行・ログイン画面への導線を出す。
 */
export function SplashScreen({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  return (
    <main
      data-testid="splash"
      data-state={error ? "error" : "loading"}
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 pb-safe pt-safe text-foreground"
    >
      <LogoMark className="size-20" />
      <div className="text-center">
        <p className="text-2xl font-extrabold tracking-wide">{APP_NAME}</p>
        <p className="text-xs tracking-[0.2em] text-muted-foreground">{APP_SUBTITLE}</p>
      </div>
      {error ? (
        <div role="alert" className="mt-2 flex max-w-xs flex-col items-center gap-3 text-center" data-testid="splash-error">
          <p className="text-sm text-danger">{error}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {onRetry && (
              <button type="button" onClick={onRetry} className="min-h-11 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm">
                再試行
              </button>
            )}
            <Link href="/login" className="inline-flex min-h-11 items-center rounded-md border bg-input px-5 text-sm">
              ログイン画面へ
            </Link>
          </div>
        </div>
      ) : (
        <div role="status" aria-live="polite" className="mt-2 flex flex-col items-center gap-2 text-sm text-muted-foreground">
          <span aria-hidden="true" className="size-7 animate-spin rounded-full border-[3px] border-muted border-t-primary" />
          <span>読み込み中...</span>
        </div>
      )}
    </main>
  );
}
