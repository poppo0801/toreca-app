"use client";

import { ExternalLink } from "lucide-react";
import type { BookmarkView } from "@/lib/collector/bookmark-state";
import { cn } from "@/lib/utils";

/**
 * Xブックマークの1件ごとの表示（起動時ポップアップ・通知で共通）。
 * X表示名／投稿内容の短い要約／元投稿へのリンク／取得・解析・登録の状況／未処理・失敗の理由。
 * 状況の記号: ✓=完了 ◷=処理待ち ⚠=情報不足・失敗（解決するまで残る）
 */
export function BookmarkRow({ b, actions }: { b: BookmarkView; actions?: React.ReactNode }) {
  return (
    <li className="space-y-0.5 rounded-md border px-2 py-1.5 text-xs" data-testid="bookmark-row" data-state={b.state} data-tone={b.tone}>
      <p className="flex min-w-0 items-start gap-1.5">
        <span
          aria-hidden="true"
          className={cn("w-4 shrink-0 text-center font-bold leading-4", b.tone === "ok" && "text-success", b.tone === "warn" && "text-warn", b.tone === "wait" && "text-info", b.tone === "none" && "text-muted-foreground")}
          data-testid="bookmark-mark"
        >
          {b.mark}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium" data-testid="bookmark-name">
            {b.name}
          </span>
          {b.summary && (
            <span className="block truncate text-muted-foreground" data-testid="bookmark-summary">
              {b.summary}
            </span>
          )}
          <span className="block" data-testid="bookmark-status">
            <span className={cn("font-medium", b.tone === "warn" && "text-warn")}>{b.stateLabel}</span>
            {b.permanent && <span className="ml-1 text-muted-foreground">（削除・非公開などで取得できません）</span>}
            {b.reason && <span className="ml-1 text-muted-foreground">{b.reason}</span>}
          </span>
          {b.supplementNote && <span className="block text-[11px] text-muted-foreground">補完: {b.supplementNote}</span>}
        </span>
        {b.url && (
          <a href={b.url} target="_blank" rel="noreferrer noopener" className="inline-flex shrink-0 items-center gap-0.5 text-info underline" data-testid="bookmark-link" aria-label={`${b.name}の元投稿を開く`}>
            元投稿 <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        )}
      </p>
      {actions}
    </li>
  );
}

/** ポップアップ最上部の「Xブックマーク」専用エリア。新規はすべて個別に表示し、多いときはこの中でスクロールする */
export function BookmarkArea({ fresh, unresolved, syncIssue }: { fresh: BookmarkView[]; unresolved: BookmarkView[]; syncIssue: string | null }) {
  if (fresh.length === 0 && unresolved.length === 0 && !syncIssue) return null;
  return (
    <section className="space-y-1.5" data-testid="bookmark-area" aria-label="Xブックマーク">
      {fresh.length > 0 && (
        <>
          <h3 className="text-sm font-semibold" data-testid="bookmark-heading">
            Xブックマーク：新規{fresh.length}件
          </h3>
          <ul className="max-h-60 space-y-1 overflow-y-auto overscroll-contain" data-testid="bookmark-fresh">
            {fresh.map((b) => (
              <BookmarkRow key={b.id} b={b} />
            ))}
          </ul>
        </>
      )}
      {syncIssue && (
        <p className="text-xs text-warn" role="alert" data-testid="bookmark-sync-issue">
          ⚠ ブックマークの取得に問題があります: {syncIssue}
        </p>
      )}
      {unresolved.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-warn" data-testid="bookmark-unresolved-heading">
            ⚠ 未解決のブックマーク：{unresolved.length}件
          </h3>
          <ul className="max-h-40 space-y-1 overflow-y-auto overscroll-contain" data-testid="bookmark-unresolved">
            {unresolved.map((b) => (
              <BookmarkRow key={b.id} b={b} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
