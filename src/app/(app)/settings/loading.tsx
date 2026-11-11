/**
 * 設定の各ページを開くまでの読み込み表示（Stage 7R）。サーバーでの取得・集計が終わる前に画面を切り替え、戻る導線と見出しの位置を先に出す。
 * 自動収集は専用の表示（collection/loading.tsx）を使う。
 */
export default function Loading() {
  return (
    <div className="space-y-3" role="status" aria-label="読み込み中" data-testid="settings-loading">
      <div className="h-5 w-16 animate-pulse rounded bg-muted" />
      <div className="h-7 w-44 animate-pulse rounded bg-muted" />
      <div className="h-11 animate-pulse rounded-md bg-muted/60" />
      <div className="h-12 animate-pulse rounded-lg bg-muted/60" />
      <div className="h-12 animate-pulse rounded-lg bg-muted/60" />
      <div className="h-12 animate-pulse rounded-lg bg-muted/60" />
    </div>
  );
}
