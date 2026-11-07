"use client";

import { useEffect, useState } from "react";
import { loadBoxReceiptsAction, recordBoxReceiptAction } from "@/app/(app)/lotteries/receipt-actions";
import { useApp } from "@/components/app-provider";
import { CountInput } from "@/components/count-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { receiptError, SHRINK_LABEL, SHRINK_STATES } from "@/lib/product-kind";
import { jstToday } from "@/lib/ai/extraction";
import type { ShrinkState } from "@/types/domain";

export interface ReceiptItem {
  id: string;
  quantity: number;
  label: string;
}

type Counts = Record<ShrinkState, number>;
const EMPTY: Counts = { shrink: 0, no_shrink: 0, unknown: 0 };

/**
 * BOXの受取時の実際のシュリンク状態を記録する。購入明細（BOX）ごとに、状態別の数量を入力する
 * （複数BOXで状態が違うときは状態ごとに数量を分ける。合計が購入数量以下）。受け取っていない分は記録に含めない。
 * 系列の「BOX販売形態」は応募判断の目安で、ここで記録する実際の状態とは別。
 */
export function BoxReceiptDialog({ items, onClose }: { items: ReceiptItem[]; onClose: () => void }) {
  const { profile } = useApp();
  const [counts, setCounts] = useState<Record<string, Counts>>({});
  const [date, setDate] = useState(() => jstToday(new Date()));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = items.map((i) => i.id).join(",");

  useEffect(() => {
    let alive = true;
    void loadBoxReceiptsAction(items.map((i) => i.id)).then((r) => {
      if (!alive) return;
      const next: Record<string, Counts> = {};
      for (const it of items) next[it.id] = { ...EMPTY };
      if (r.ok) {
        for (const row of r.receipts) {
          if (next[row.purchaseItemId]) next[row.purchaseItemId][row.state] = row.quantity;
          setDate(row.receivedOn);
        }
      }
      setCounts(next);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 対象の明細が変わったときだけ読み込む
  }, [key]);

  const statesOf = (id: string) => SHRINK_STATES.map((state) => ({ state, quantity: counts[id]?.[state] ?? 0 })).filter((s) => s.quantity > 0);
  const problem = items.map((it) => receiptError(statesOf(it.id), it.quantity)).find(Boolean) ?? null;

  const save = async () => {
    setBusy(true);
    setError(null);
    for (const it of items) {
      const r = await recordBoxReceiptAction(it.id, date, statesOf(it.id), profile.id);
      if (!r.ok) {
        setError(r.error);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="box-receipt-dialog">
        <DialogTitle>受取時のシュリンク状態</DialogTitle>
        <DialogDescription className="sr-only">受け取ったBOXの実際の状態を記録します</DialogDescription>
        <label className="mt-3 block text-sm">
          受取日
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 h-11 w-full rounded-md border bg-input px-3 text-base" aria-label="受取日" />
        </label>
        <div className="mt-3 space-y-3">
          {items.map((it) => (
            <fieldset key={it.id} className="rounded-md border p-2.5" data-testid="receipt-item">
              <legend className="px-1 text-xs font-medium">
                {it.label} ・購入 {it.quantity}BOX
              </legend>
              <div className="grid grid-cols-3 gap-2">
                {SHRINK_STATES.map((s) => (
                  <label key={s} className="text-center text-[11px]">
                    {SHRINK_LABEL[s]}
                    <CountInput
                      aria-label={`${it.label}の${SHRINK_LABEL[s]}`}
                      max={it.quantity}
                      value={counts[it.id]?.[s] ?? 0}
                      onChange={(n) => setCounts((c) => ({ ...c, [it.id]: { ...(c[it.id] ?? EMPTY), [s]: n } }))}
                      className="mt-1 h-11 w-full rounded-md border bg-input px-1 text-center text-base"
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        {(error || problem) && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error ?? problem}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              あとで
            </Button>
          </DialogClose>
          <Button onClick={() => void save()} disabled={busy || !loaded || problem !== null} data-testid="receipt-save">
            記録する
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
