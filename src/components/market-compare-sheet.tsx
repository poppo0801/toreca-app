"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { loadCompareAction, type CompareData } from "@/app/(app)/market-memo/daily-actions";
import { DexImage } from "@/components/dex-image";
import { COMPARE_ROW_CLASS, CompareRowContent } from "@/components/compare-row";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { mergeDaily, type DailyRow } from "@/lib/zukan/daily";
import { splitCurrent } from "@/lib/zukan/freshness";
import { matchPokemonByCardName } from "@/lib/zukan/pokemon-match";
import { rankOrder } from "@/lib/zukan/zukan";


/**
 * 相場比較表（カード名・画像のタップ）。151図鑑と相場調査メモの**両方**から、同じカード（収録セット・番号・レアリティが同じ。無いときは名前）の店舗別価格を比較する。今日の調査結果も含む。
 *  - 最新の販売情報（同じ系列＋店舗＋状態の最新）を、販売中→完売の順・価格の安い順に表示（状態・価格・調査日・最終確認日・完売）。
 *  - 古い記録は「過去の参考情報」に分けて表示（削除しない）。同じポケモンでもセット・番号・レアリティが違うカードは別。両方の記録元に同じ内容があれば1行にまとめる。
 */
export function MarketCompareSheet({ card, onClose }: { card: { cardName: string; setName: string; cardNumber: string; rarity: string }; onClose: () => void }) {
  const [data, setData] = useState<CompareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadCompareAction(card).then((r) => {
      if (!live) return;
      if (r.ok) setData(r.data);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [card]);
  const { current, past } = useMemo(() => {
    const rows = data ? mergeDaily(data.records) : [];
    const { current: c, superseded } = splitCurrent(rows.map((r) => ({ ...r, id: r.key })));
    const byPrice = (a: DailyRow, b: DailyRow) => Number(a.soldOut) - Number(b.soldOut) || a.priceYen - b.priceYen || rankOrder(a.condition) - rankOrder(b.condition) || a.storeName.localeCompare(b.storeName, "ja");
    return { current: [...c].sort(byPrice), past: [...superseded].sort((a, b) => b.surveyedOn.localeCompare(a.surveyedOn) || b.createdAt.localeCompare(a.createdAt)) };
  }, [data]);
  const dex = matchPokemonByCardName(card.cardName);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="compare-sheet" aria-describedby="compare-desc">
        <div className="flex items-center gap-2.5 px-4 pb-2">
          {dex ? <DexImage no={dex.no} name={dex.name} className="size-12" /> : null}
          <div className="min-w-0">
            <SheetTitle>{card.cardName}</SheetTitle>
            <SheetDescription id="compare-desc" className="text-xs">
              {[card.setName, card.cardNumber, card.rarity].filter(Boolean).join(" ・ ") || "セット・番号は未入力"} の店舗別価格
            </SheetDescription>
          </div>
        </div>
        <SheetBody className="space-y-3 border-t pt-3">
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          {!data && !error && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-1 inline size-4 animate-spin" aria-hidden="true" />
              読み込み中…
            </p>
          )}
          {data && (
            <>
              <section aria-label="最新の販売情報" data-testid="compare-current">
                <h3 className="mb-1 text-xs font-bold">最新の販売情報（{current.length}件）</h3>
                <ul className="space-y-1">
                  {current.map((r) => (
                    <CompareRow key={r.key} r={r} />
                  ))}
                  {current.length === 0 && <li className="text-xs text-muted-foreground">販売情報がありません。</li>}
                </ul>
              </section>
              {past.length > 0 && (
                <section aria-label="過去の参考情報" data-testid="compare-past">
                  <h3 className="mb-1 text-xs font-bold text-muted-foreground">過去の参考情報（{past.length}件）</h3>
                  <ul className="space-y-1 opacity-70">
                    {past.map((r) => (
                      <CompareRow key={r.key} r={r} past />
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function CompareRow({ r, past = false }: { r: DailyRow; past?: boolean }) {
  // 表示は相場調査メモ・151図鑑の価格一覧と共通（CompareRowContent）。日付だけ（最新の販売情報は最終確認日、過去の参考情報は調査日）
  return (
    <li className={COMPARE_ROW_CLASS} data-testid="compare-row" data-soldout={r.soldOut ? "1" : "0"} data-past={past ? "1" : "0"}>
      <CompareRowContent testIdPrefix="compare" chainName={r.chainName} storeName={r.storeName} date={past ? r.surveyedOn : r.lastConfirmedOn} condition={r.condition} priceYen={r.priceYen} soldOut={r.soldOut} />
    </li>
  );
}
