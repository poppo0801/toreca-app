"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RankBadge } from "@/components/rank-badge";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
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
/** 一覧の調査日は「月/日」（年は詳細で確認） */
const shortDate = (d: string) => {
  const [, m, day] = d.split("-").map(Number);
  return `${m}/${day}`;
};

/**
 * 店舗価格の一覧（151図鑑の価格調査・相場調査メモ共通）。
 *  - **一覧は要点だけ**: 1件=高さを抑えたタップ可能なブロック。常時表示は「状態ランク → 系列・店舗 → 調査日 → 金額（右端）」の4つだけ。
 *    購入・編集・削除・推移・備考・説明は一覧に出さず、**ブロックをタップした詳細**に集約する。
 *    最安・参考価格・購入済みは、控えめな色と記号（価格の色／左の線／薄い表示／✓）で示す（詳細で文字で確認できる）。
 *  - 初期は状態の良い順（A+→C）→同ランク内は価格の安い順。「価格の安い順」に切り替えられる
 *  - 30日を超えた記録は「参考価格」（最安値の強調対象から除外。削除せず履歴として残す）
 *  - 購入済みの記録は二重購入できない。同じ店舗の過去の調査（価格推移）は詳細で見られる
 */
export function PriceList({ rows, today, boughtIds, onBuy, onEdit, onDelete }: { rows: PriceRow[]; today: string; boughtIds: Set<string>; onBuy: (r: PriceRow) => void; onEdit: (r: PriceRow) => void; onDelete: (r: PriceRow) => void }) {
  const [sort, setSort] = useState<PriceSort>("condition");
  const [openId, setOpenId] = useState<string | null>(null);
  const sorted = sortPrices(rows, sort);
  const best = cheapestIds(rows, today);
  const opened = openId ? rows.find((r) => r.id === openId) : undefined;
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
      <ul className="space-y-1">
        {sorted.map((r) => {
          const ref = isReferencePrice(r, today);
          const bought = boughtIds.has(r.id);
          const isBest = best.has(r.id);
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setOpenId(r.id)}
                data-testid="price-row"
                data-ref={ref ? "true" : "false"}
                data-best={isBest ? "true" : "false"}
                data-bought={bought ? "true" : "false"}
                aria-label={`${r.condition} ${r.chainName} ${r.storeName} ${r.surveyedOn} ${yen(r.priceYen)}の詳細を開く`}
                className={cn("grid min-h-12 w-full grid-cols-[2.25rem_minmax(0,1fr)_auto_auto] items-center gap-x-2 rounded-lg border px-2 py-1 text-left", isBest && "border-l-4 border-l-success", ref && "opacity-70")}
              >
                <span data-testid="price-rank-label" className="flex justify-center">
                  <RankBadge rank={r.condition} />
                </span>
                <span className="min-w-0 text-xs leading-tight" data-testid="price-store">
                  {r.chainName && <span className="block truncate text-[10px] text-muted-foreground">{r.chainName}</span>}
                  <span className="block truncate font-medium">{r.storeName}</span>
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground" data-testid="price-date">
                  {shortDate(r.surveyedOn)}
                </span>
                <span className={cn("flex items-center justify-end gap-0.5 whitespace-nowrap text-right text-sm font-bold tabular-nums", isBest && "text-success")} data-testid="price-amount">
                  {bought && <Check className="size-3 text-info" strokeWidth={3} aria-hidden="true" />}
                  {yen(r.priceYen)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {opened && <PriceDetail row={opened} rows={rows} today={today} bought={boughtIds.has(opened.id)} best={best.has(opened.id)} onClose={() => setOpenId(null)} onBuy={onBuy} onEdit={onEdit} onDelete={onDelete} />}
    </div>
  );
}

/** 価格の詳細（タップで開く）: 備考・最安/参考/購入済み・同じ店舗の価格推移・購入/編集/削除。編集・削除・購入は呼び出し側の確認フローを通す */
function PriceDetail({ row, rows, today, bought, best, onClose, onBuy, onEdit, onDelete }: { row: PriceRow; rows: PriceRow[]; today: string; bought: boolean; best: boolean; onClose: () => void; onBuy: (r: PriceRow) => void; onEdit: (r: PriceRow) => void; onDelete: (r: PriceRow) => void }) {
  const ref = isReferencePrice(row, today);
  const hist = storeHistory(rows, row.storeName);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="price-detail" aria-describedby="price-detail-desc">
        <div className="px-4 pb-2">
          <SheetTitle className="flex flex-wrap items-baseline gap-x-2">
            <RankBadge rank={row.condition} className="h-5 text-xs" />
            <span className="tabular-nums">{yen(row.priceYen)}</span>
          </SheetTitle>
          <SheetDescription id="price-detail-desc" className="text-xs">
            {row.chainName ? `${row.chainName} ` : ""}
            {row.storeName} ・ {row.surveyedOn}
          </SheetDescription>
        </div>
        <SheetBody className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap gap-1.5 text-[11px]" data-testid="price-detail-badges">
            {best && <span className="rounded bg-success px-1.5 py-0.5 font-bold text-white">最安</span>}
            {ref && <span className="rounded border px-1.5 py-0.5 text-muted-foreground">参考価格（30日超）</span>}
            {bought && <span className="rounded border border-info px-1.5 py-0.5 text-info">購入済み</span>}
          </div>
          {row.note && (
            <p className="text-sm" data-testid="price-detail-note">
              {row.note}
            </p>
          )}
          {hist.length > 1 && (
            <section aria-label="この店の価格推移" data-testid="price-history">
              <h4 className="mb-1 text-xs font-bold">この店の推移（{hist.length}件）</h4>
              <ul className="space-y-0.5 text-xs">
                {hist.map((h) => (
                  <li key={h.id} className={cn("flex justify-between gap-2", h.id === row.id && "font-bold")}>
                    <span>{h.surveyedOn}</span>
                    <span>{h.condition}</span>
                    <span className="tabular-nums">{yen(h.priceYen)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              className="min-h-10"
              disabled={bought}
              onClick={() => {
                onClose();
                onBuy(row);
              }}
              data-testid="price-buy"
            >
              {bought ? "購入済み" : "この価格で購入"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="min-h-10"
              onClick={() => {
                onClose();
                onEdit(row);
              }}
              data-testid="price-edit"
            >
              編集
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="min-h-10"
              onClick={() => {
                onClose();
                onDelete(row);
              }}
              data-testid="price-delete"
            >
              削除
            </Button>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
