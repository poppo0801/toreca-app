"use client";

import { ChartColumn } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SummaryCell {
  label: string;
  value: string;
  /** 項目名の横に出す小さな補足（最終価格取得日など） */
  sub?: string;
  subTestId?: string;
  /** 「一部」の印 */
  partial?: boolean;
}

/** 金額が長いときは文字を小さくして、3分割の各エリアからはみ出さない */
const valueSize = (v: string) => (v.length >= 12 ? "text-[11px]" : v.length >= 10 ? "text-xs" : v.length >= 8 ? "text-[13px]" : "text-sm");

/**
 * 保有状況の集計（購入／買取／枚数・BOX数）を、横方向に3分割したエリアに配置する（Stage 6R）。
 * 各エリアは「項目名（小）／数値」。タップで詳細の開閉。カードとBOXで共通。
 */
export function SummaryTriple({ cells, expanded, onToggle, testId, loading = false, refreshing = false }: { cells: [SummaryCell, SummaryCell, SummaryCell]; expanded: boolean; onToggle: () => void; testId: string; loading?: boolean; /** 相場・価格の更新後に集計を取り直している間（古い値を確定表示しないよう薄く表示する） */ refreshing?: boolean }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded} className={cn("relative grid min-h-12 w-full grid-cols-3 text-left transition-opacity", refreshing && "opacity-60")} aria-busy={refreshing || undefined} data-refreshing={refreshing ? "1" : undefined} data-testid={testId}>
      {cells.map((c, i) => (
        <span key={c.label} className={cn("relative flex min-w-0 flex-col justify-center px-2.5 py-1", i > 0 && "border-l")} data-testid={`${testId}-cell-${i}`}>
          <span className="whitespace-nowrap text-[10px] leading-4 text-muted-foreground">{c.label}</span>
          {/* 項目名と数値の間に空白を入れる（テキストとして読んだとき「購入 12,000円」） */}
          <span className="sr-only"> </span>
          <span className={cn("truncate font-bold tabular-nums leading-5", valueSize(c.value), loading && "text-muted-foreground")}>{c.value}</span>
          {/* 補足（最終価格取得日・一部）は項目名の右上に小さく添える */}
          {(c.partial || c.sub) && (
            <span className="absolute right-1.5 top-1 flex items-center gap-1 text-[9px] leading-3.5 text-muted-foreground" style={{ right: i === 2 ? "1.25rem" : undefined }}>
              {c.partial && <span className="rounded-full border border-warn px-1 text-warn">一部</span>}
              {c.sub && <span data-testid={c.subTestId}>{c.sub}</span>}
            </span>
          )}
        </span>
      ))}
      <ChartColumn className="absolute right-1 top-1 size-3 text-muted-foreground/70" aria-hidden="true" />
    </button>
  );
}
