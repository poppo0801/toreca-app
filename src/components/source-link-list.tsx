"use client";

import { ExternalLink } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { pickSourceLinks, type SourceLink } from "@/lib/source-links";
import { cn } from "@/lib/utils";

/**
 * 一次情報リンク（Stage 9H-3L・9Y）。「種類｜ドメイン」を青文字の下線つきの外部リンクで、横に連続して表示する。
 *  - 幅に応じて折り返し、2行以上になるときは初期状態で1行に省略して「ほかN件」から展開できる（重複URLは表示しない）
 * 外部ブラウザ（別タブ／iPhoneのホーム画面アプリでは外部で開く）で開き、アプリ内の入力状態・スクロール位置には触れない。
 * 表示できるリンクが無いときは何も描画しない（空の枠・余白を作らない）。
 */
export function SourceLinkList({ lottery, officialHosts, max = 10, className, testId = "primary-links", ariaLabel = "一次情報リンク" }: { lottery: { announcementUrl?: string | null; sourceUrls?: string[] }; officialHosts?: string[]; max?: number; className?: string; testId?: string; ariaLabel?: string }) {
  const links: SourceLink[] = pickSourceLinks(lottery, { officialHosts }, max);
  const listRef = useRef<HTMLUListElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(0); // 1行目に収まらずに隠れている件数

  const measure = useCallback(() => {
    const ul = listRef.current;
    if (!ul) return;
    const items = Array.from(ul.children) as HTMLElement[];
    if (items.length === 0) return;
    const firstTop = items[0].offsetTop;
    setHidden(items.filter((el) => el.offsetTop > firstTop + 2).length);
  }, []);

  const key = links.map((l) => l.url).join("\n");
  useLayoutEffect(() => {
    // 展開中は測定しない（隠れた件数は折りたたみ時の値を保つ）
    if (expanded) return;
    measure();
    const ul = listRef.current;
    if (!ul || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(ul);
    return () => ro.disconnect();
  }, [key, expanded, measure]);

  if (links.length === 0) return null;
  return (
    <div className={cn("min-w-0", className)}>
      <ul
        ref={listRef}
        className={cn("flex flex-wrap items-center gap-x-3 gap-y-0", !expanded && "max-h-8 overflow-hidden")}
        aria-label={ariaLabel}
        data-testid={testId}
        data-expanded={expanded ? "true" : "false"}
      >
        {links.map((l) => (
          <li key={l.url} className="min-w-0 max-w-full">
            <a href={l.url} target="_blank" rel="noreferrer noopener" title={l.url} className="flex min-h-8 max-w-full items-center gap-1 text-xs text-info underline" data-testid="primary-link" data-kind={l.kind}>
              <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{l.label}</span>
            </a>
          </li>
        ))}
      </ul>
      {(hidden > 0 || expanded) && links.length > 1 && (
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="min-h-8 text-xs text-muted-foreground underline" data-testid={`${testId}-toggle`}>
          {expanded ? "閉じる" : `ほか${hidden}件`}
        </button>
      )}
    </div>
  );
}
