"use client";

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RankBadge } from "@/components/rank-badge";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { currentWithStatus, indexEvents, statusOf, type PriceEvent, type WithStatus } from "@/lib/zukan/freshness";
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
  /** カードの識別キー（151図鑑: 同じポケモンの複数カードが混ざるため、販売情報の同一性にカードを含める）。相場調査メモは1カードの一覧なので不要 */
  cardKey?: string;
  /** カードの表示（収録セット・番号・レア。151図鑑の一覧で、どのカードの価格かを分かるようにする） */
  cardLabel?: string;
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
 *  - **現在の情報だけを一覧に出す**: 同一カード・同一系列＋店舗・同一状態ランクの記録は最新の1件だけ。古い記録は通常の一覧から外すが、削除せず、詳細の「この店の推移」で確認できる。
 *  - 完売の販売情報は「完売」バッジつきで参考として残し、販売中と区別する（最安の強調対象にしない）。表示する日付は最終確認日（更新で今日になる）。
 *  - 初期は状態の良い順（S→D）→同ランク内は価格の安い順。「価格の安い順」に切り替えられる
 *  - 最終確認から30日を超えた記録は「参考価格」（最安値の強調対象から除外。削除せず履歴として残す）
 *  - 購入済みの記録は二重購入できない。詳細に「更新」（本日も販売中を確認）と「完売」がある（履歴に追記。価格記録は書き換えない）
 */
export function PriceList({
  rows,
  today,
  boughtIds,
  events,
  keyOf,
  onBuy,
  onEdit,
  onDelete,
  onConfirm,
  onSoldOut,
  onEditCard,
}: {
  rows: PriceRow[];
  today: string;
  boughtIds: Set<string>;
  /** 販売情報の事象（更新・完売）。無ければ全て販売中・調査日が最終確認日 */
  events?: PriceEvent[];
  /** 記録の識別キー（`zukan:<id>` / `market:<id>`）。事象との対応に使う */
  keyOf?: (r: PriceRow) => string;
  onBuy: (r: PriceRow) => void;
  onEdit: (r: PriceRow) => void;
  onDelete: (r: PriceRow) => void;
  /** 「更新」「完売」。エラーメッセージ（成功は null）を返す */
  onConfirm?: (r: PriceRow) => Promise<string | null>;
  onSoldOut?: (r: PriceRow) => Promise<string | null>;
  /** 151図鑑: 登録済みのカード情報の編集 */
  onEditCard?: (r: PriceRow) => void;
}) {
  const [sort, setSort] = useState<PriceSort>("condition");
  const [openId, setOpenId] = useState<string | null>(null);
  const evIndex = useMemo(() => indexEvents(events ?? []), [events]);
  const key = keyOf ?? ((r: PriceRow) => r.id);
  const { current } = useMemo(() => currentWithStatus(rows, evIndex, key, (r) => r.cardKey ?? ""), [rows, evIndex, key]);
  // 並び替え・最安・参考の判定は、確認日（調査日と更新の新しい方）を日付として使う
  const asShown = current.map((r) => ({ ...r, surveyedOn: r.lastConfirmedOn }));
  const sorted = sortPrices(asShown, sort);
  const best = cheapestIds(asShown.filter((r) => !r.soldOut), today);
  const opened = openId ? current.find((r) => r.id === openId) : undefined;
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
          const ref = !r.soldOut && isReferencePrice(r, today);
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
                data-soldout={r.soldOut ? "true" : "false"}
                aria-label={`${r.condition} ${r.chainName} ${r.storeName} ${r.lastConfirmedOn} ${yen(r.priceYen)}${r.soldOut ? " 完売" : ""}の詳細を開く`}
                className={cn("grid min-h-12 w-full grid-cols-[2.25rem_minmax(0,1fr)_auto_auto] items-center gap-x-2 rounded-lg border px-2 py-1 text-left", isBest && "border-l-4 border-l-success", (ref || r.soldOut) && "opacity-70")}
              >
                <span data-testid="price-rank-label" className="flex justify-center">
                  <RankBadge rank={r.condition} />
                </span>
                <span className="min-w-0 text-xs leading-tight" data-testid="price-store">
                  {r.chainName && <span className="block truncate text-[10px] text-muted-foreground">{r.chainName}</span>}
                  <span className="block truncate font-medium">{r.storeName}</span>
                  {r.cardLabel && (
                    <span className="block truncate text-[10px] text-muted-foreground" data-testid="price-card-label">
                      {r.cardLabel}
                    </span>
                  )}
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground" data-testid="price-date">
                  {shortDate(r.lastConfirmedOn)}
                </span>
                <span className={cn("flex items-center justify-end gap-1 whitespace-nowrap text-right text-sm font-bold tabular-nums", isBest && "text-success")} data-testid="price-amount">
                  {r.soldOut && (
                    <span className="rounded border border-danger px-1 text-[10px] font-bold leading-4 text-danger" data-testid="soldout-badge">
                      完売
                    </span>
                  )}
                  {bought && <Check className="size-3 text-info" strokeWidth={3} aria-hidden="true" />}
                  {yen(r.priceYen)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {opened && (
        <PriceDetail row={opened} rows={rows} evIndex={evIndex} keyOf={key} today={today} bought={boughtIds.has(opened.id)} best={best.has(opened.id)} onClose={() => setOpenId(null)} onBuy={onBuy} onEdit={onEdit} onDelete={onDelete} onConfirm={onConfirm} onSoldOut={onSoldOut} onEditCard={onEditCard} />
      )}
    </div>
  );
}

/** 価格の詳細（タップで開く）: 備考・最安/参考/完売/購入済み・調査日と最終確認日・同じ店舗の価格推移（過去の記録を含む）・更新/完売/購入/編集/削除。編集・削除・購入は呼び出し側の確認フローを通す */
function PriceDetail({
  row,
  rows,
  evIndex,
  keyOf,
  today,
  bought,
  best,
  onClose,
  onBuy,
  onEdit,
  onDelete,
  onConfirm,
  onSoldOut,
  onEditCard,
}: {
  row: WithStatus<PriceRow>;
  rows: PriceRow[];
  evIndex: Map<string, PriceEvent[]>;
  keyOf: (r: PriceRow) => string;
  today: string;
  bought: boolean;
  best: boolean;
  onClose: () => void;
  onBuy: (r: PriceRow) => void;
  onEdit: (r: PriceRow) => void;
  onDelete: (r: PriceRow) => void;
  onConfirm?: (r: PriceRow) => Promise<string | null>;
  onSoldOut?: (r: PriceRow) => Promise<string | null>;
  onEditCard?: (r: PriceRow) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = !row.soldOut && isReferencePrice({ surveyedOn: row.lastConfirmedOn }, today);
  const hist = storeHistory(rows.filter((r) => (r.cardKey ?? "") === (row.cardKey ?? "")), row.storeName);
  const run = async (f?: (r: PriceRow) => Promise<string | null>) => {
    if (!f || busy) return;
    setBusy(true);
    setError(null);
    const e = await f(row);
    setBusy(false);
    if (e) setError(e);
    else onClose();
  };
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
            {row.storeName} ・ 調査 {row.surveyedOn}
            {row.lastConfirmedOn !== row.surveyedOn ? ` ・ 最終確認 ${row.lastConfirmedOn}` : ""}
          </SheetDescription>
        </div>
        <SheetBody className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap gap-1.5 text-[11px]" data-testid="price-detail-badges">
            {best && <span className="rounded bg-success px-1.5 py-0.5 font-bold text-white">最安</span>}
            {row.soldOut && (
              <span className="rounded border border-danger px-1.5 py-0.5 font-bold text-danger" data-testid="detail-soldout">
                完売{row.soldOutOn ? `（${row.soldOutOn}）` : ""}
              </span>
            )}
            {ref && <span className="rounded border px-1.5 py-0.5 text-muted-foreground">参考価格（確認から30日超）</span>}
            {bought && <span className="rounded border border-info px-1.5 py-0.5 text-info">購入済み</span>}
          </div>
          {row.soldOut && <p className="text-[11px] text-muted-foreground">この店舗の該当の販売情報が終了した記録です（カード全体の在庫がないという意味ではありません）。販売が再確認できたら「更新」で販売中に戻せます。</p>}
          {row.cardLabel && <p className="text-xs text-muted-foreground">{row.cardLabel}</p>}
          {row.note && (
            <p className="text-sm" data-testid="price-detail-note">
              {row.note}
            </p>
          )}
          {hist.length > 1 && (
            <section aria-label="この店の価格推移" data-testid="price-history">
              <h4 className="mb-1 text-xs font-bold">この店の推移（{hist.length}件）</h4>
              <ul className="space-y-0.5 text-xs">
                {hist.map((h) => {
                  const st = statusOf(h, evIndex.get(keyOf(h)));
                  return (
                    <li key={h.id} className={cn("flex justify-between gap-2", h.id === row.id && "font-bold")}>
                      <span>{h.surveyedOn}</span>
                      <span>{h.condition}</span>
                      <span className="tabular-nums">
                        {yen(h.priceYen)}
                        {st.soldOut ? "（完売）" : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {error && (
            <p role="alert" className="text-xs text-danger" data-testid="price-detail-error">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {onConfirm && (
              <Button size="sm" variant="outline" className="min-h-10" disabled={busy} onClick={() => void run(onConfirm)} data-testid="price-confirm">
                {row.soldOut ? "更新（販売中に戻す）" : "更新"}
              </Button>
            )}
            {onSoldOut && (
              <Button size="sm" variant="outline" className="min-h-10" disabled={busy || row.soldOut} onClick={() => void run(onSoldOut)} data-testid="price-soldout">
                完売
              </Button>
            )}
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
            {onEditCard && (
              <Button
                size="sm"
                variant="outline"
                className="min-h-10"
                onClick={() => {
                  onClose();
                  onEditCard(row);
                }}
                data-testid="price-edit-card"
              >
                カード情報を編集
              </Button>
            )}
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
