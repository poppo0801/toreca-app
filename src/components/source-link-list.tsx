"use client";

import { ExternalLink } from "lucide-react";
import { pickSourceLinks, type SourceLink } from "@/lib/source-links";
import { cn } from "@/lib/utils";

/**
 * 一次情報リンク（Stage 9H-3L）。「種類｜ドメイン」を青文字の下線つきの外部リンクで表示する。
 * 外部ブラウザ（別タブ／iPhoneのホーム画面アプリでは外部で開く）で開き、アプリ内の入力状態・スクロール位置には触れない。
 * 表示できるリンクが無いときは何も描画しない（空の枠・余白を作らない）。
 */
export function SourceLinkList({ lottery, officialHosts, max = 3, className, testId = "primary-links", ariaLabel = "一次情報リンク" }: { lottery: { announcementUrl?: string | null; sourceUrls?: string[] }; officialHosts?: string[]; max?: number; className?: string; testId?: string; ariaLabel?: string }) {
  const links: SourceLink[] = pickSourceLinks(lottery, { officialHosts }, max);
  if (links.length === 0) return null;
  return (
    <ul className={cn("space-y-0.5", className)} aria-label={ariaLabel} data-testid={testId}>
      {links.map((l) => (
        <li key={l.url} className="min-w-0">
          <a href={l.url} target="_blank" rel="noreferrer noopener" title={l.url} className="flex min-h-8 max-w-full items-center gap-1 text-xs text-info underline" data-testid="primary-link" data-kind={l.kind}>
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{l.label}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
