/** 自動収集の画面を開くまでの読み込み表示（サーバーの集計が終わる前に、すぐ画面を切り替えるため） */
export default function Loading() {
  return (
    <div className="space-y-3" role="status" aria-label="読み込み中" data-testid="collection-loading">
      <div className="h-5 w-24 animate-pulse rounded bg-muted" />
      <div className="h-7 w-48 animate-pulse rounded bg-muted" />
      <div className="h-28 animate-pulse rounded-lg bg-muted/60" />
      <div className="h-40 animate-pulse rounded-lg bg-muted/60" />
    </div>
  );
}
