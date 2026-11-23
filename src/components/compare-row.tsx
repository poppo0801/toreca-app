"use client";

import { Check } from "lucide-react";
import { RankBadge } from "@/components/rank-badge";
import { StoreIdentity } from "@/components/store-identity";
import { cn } from "@/lib/utils";

/** 相場比較表の1行の枠（本日の調査結果・相場調査メモ・151図鑑で共通）。高さ・余白・角丸・文字サイズはここだけで決める */
export const COMPARE_ROW_CLASS = "flex min-h-12 w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left";

export const compareYen = (v: number) => `${v.toLocaleString("ja-JP")}円`;
/** 日付は「月/日」（年は詳細で確認） */
export const compareDate = (d: string) => {
  const [, m, day] = d.split("-").map(Number);
  return `${m}/${day}`;
};

/**
 * 相場比較表の1行の中身（共通部品）。
 *   1行目: ［小ロゴ］系列名 店舗名　｜　状態ランク　価格
 *   2行目: 日付（小さく。「調査」などの文字は付けない）
 * 収録セット・番号・レアリティは行に出さない（比較表の見出しで分ける）。
 * testIdPrefix: 画面ごとの識別（`price` / `compare`）。表示は同じ。
 */
export function CompareRowContent({
  testIdPrefix,
  chainName,
  storeName,
  date,
  condition,
  priceYen,
  soldOut = false,
  bought = false,
  best = false,
}: {
  testIdPrefix: "price" | "compare";
  chainName: string;
  storeName: string;
  date: string;
  condition: string;
  priceYen: number;
  soldOut?: boolean;
  bought?: boolean;
  best?: boolean;
}) {
  return (
    <>
      <span className="min-w-0 flex-1" data-testid={`${testIdPrefix}-store`}>
        <StoreIdentity chainName={chainName} storeName={storeName} />
        <span className="mt-0.5 block text-[10px] leading-none tabular-nums text-muted-foreground" data-testid={`${testIdPrefix}-date`}>
          {compareDate(date)}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span data-testid={`${testIdPrefix}-rank-label`} className="flex w-7 justify-center">
          <RankBadge rank={condition} />
        </span>
        <span className={cn("flex min-w-[4.5rem] items-center justify-end gap-1 whitespace-nowrap text-right text-sm font-bold tabular-nums", best && "text-success")} data-testid={`${testIdPrefix}-amount`}>
          {soldOut && (
            <span className="rounded border border-danger px-1 text-[10px] font-bold leading-4 text-danger" data-testid="soldout-badge">
              完売
            </span>
          )}
          {bought && <Check className="size-3 text-info" strokeWidth={3} aria-hidden="true" />}
          {compareYen(priceYen)}
        </span>
      </span>
    </>
  );
}
