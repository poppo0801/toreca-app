"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { cheapestIds, isReferencePrice, sortPrices, storeHistory, type PriceSort } from "@/lib/zukan/zukan";

export interface PriceRow {
  id: string;
  storeName: string;
  chainName: string;
  surveyedOn: string;
  condition: string;
  priceYen: number;
  note: string;
  createdAt: string;
}

const yen = (v: number) => `${v.toLocaleString("ja-JP")}円`;

/**
 * 店舗価格の一覧（151図鑑の価格調査・相場調査メモ共通）。
 *  - 初期は状態の良い順（A+→C）→同ランク内は価格の安い順。「価格の安い順」に切り替えられる
 *  - 30日を超えた記録は「参考価格」（最安値の強調対象から除外。削除せず履歴として残す）
 *  - 購入済みの記録は「購入済み」（二重購入できない）。同じ店舗の過去の調査（価格推移）を展開して見られる
 */
export function PriceList({ rows, today, boughtIds, onBuy, onEdit, onDelete }: { rows: PriceRow[]; today: string; boughtIds: Set<string>; onBuy: (r: PriceRow) => void; onEdit: (r: PriceRow) => void; onDelete: (r: PriceRow) => void }) {
  const [sort, setSort] = useState<PriceSort>("condition");
  const [open, setOpen] = useState<string | null>(null);
  const sorted = sortPrices(rows, sort);
  const best = cheapestIds(rows, today);
  return (
    <div className="space-y-1.5" data-testid="price-list">
      <div role="radiogroup" aria-label="並び順" className="inline-flex rounded-md border p-0.5 text-xs" data-testid="price-sort">
        {(
          [
            ["condition", "状態優先"],
            ["price", "価格の安い順"],
          ] as const
        ).map(([v, t]) => (
          <button key={v} type="button" role="radio" aria-checked={sort === v} onClick={() => setSort(v)} className={cn("min-h-8 rounded px-2.5", sort === v ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
            {t}
          </button>
        ))}
      </div>
      {sorted.length === 0 && <p className="text-xs text-muted-foreground">まだ価格の記録がありません。</p>}
      <ul className="space-y-1.5">
        {sorted.map((r) => {
          const ref = isReferencePrice(r, today);
          const bought = boughtIds.has(r.id);
          const hist = storeHistory(rows, r.storeName);
          return (
            <li key={r.id} data-testid="price-row" data-ref={ref ? "true" : "false"} data-best={best.has(r.id) ? "true" : "false"} className={cn("rounded-lg border px-2.5 py-2 text-sm", best.has(r.id) && "border-success bg-success/10", ref && "opacity-75")}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="rounded border px-1.5 text-xs font-bold" data-testid="price-rank-label">
                  {r.condition}
                </span>
                <span className={cn("text-base font-bold tabular-nums", best.has(r.id) && "text-success")}>{yen(r.priceYen)}</span>
                {best.has(r.id) && <span className="rounded bg-success px-1.5 text-[10px] font-bold text-white">最安</span>}
                {ref && <span className="rounded border px-1.5 text-[10px] text-muted-foreground">参考価格</span>}
                {bought && <span className="rounded border border-info px-1.5 text-[10px] text-info">購入済み</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                {r.storeName}
                {r.chainName ? `（${r.chainName}）` : ""} ・ {r.surveyedOn}
                {r.note ? ` ・ ${r.note}` : ""}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Button size="sm" className="min-h-9" disabled={bought} onClick={() => onBuy(r)} data-testid="price-buy">
                  {bought ? "購入済み" : "この価格で購入"}
                </Button>
                <Button size="sm" variant="outline" className="min-h-9" onClick={() => onEdit(r)}>
                  編集
                </Button>
                <Button size="sm" variant="outline" className="min-h-9" onClick={() => onDelete(r)}>
                  削除
                </Button>
                {hist.length > 1 && (
                  <button type="button" className="min-h-9 text-xs text-info underline" onClick={() => setOpen(open === r.id ? null : r.id)} data-testid="price-history-toggle">
                    この店の推移（{hist.length}件）
                  </button>
                )}
              </div>
              {open === r.id && (
                <ul className="mt-1 space-y-0.5 border-t pt-1 text-xs" data-testid="price-history">
                  {hist.map((h) => (
                    <li key={h.id} className="flex justify-between gap-2">
                      <span>{h.surveyedOn}</span>
                      <span>{h.condition}</span>
                      <span className="tabular-nums">{yen(h.priceYen)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
