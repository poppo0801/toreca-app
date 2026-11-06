"use client";

import { useState } from "react";
import { saveConditionMultipliersAction } from "@/app/(app)/collection/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DEFAULT_MULTIPLIERS, GRADE_DESCRIPTION, MULTIPLIER_MAX, MULTIPLIER_MIN, VALUATION_GRADES, validateMultipliers, type ConditionMultipliers } from "@/lib/condition-value";

/**
 * 状態別の評価倍率（%）。コレクションの評価額だけに使い、基準相場・取得相場・手動価格は変更しない。
 * 状態別の実際の相場が取得できているカードは、倍率ではなくその相場を使う。
 */
export function ConditionMultipliersDialog({ open, onOpenChange, value, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; value: ConditionMultipliers; onSaved: (m: ConditionMultipliers) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(VALUATION_GRADES.map((g) => [g, String(value[g])])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const parsed = validateMultipliers(Object.fromEntries(VALUATION_GRADES.map((g) => [g, Number(draft[g])])));
    if (!parsed) return setError(`倍率は${MULTIPLIER_MIN}〜${MULTIPLIER_MAX}の整数（%）で入力してください`);
    setBusy(true);
    const r = await saveConditionMultipliersAction(parsed);
    setBusy(false);
    if (r.ok) {
      onSaved(r.multipliers);
      onOpenChange(false);
    } else setError(r.error);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="multipliers-dialog" aria-describedby="mult-desc">
        <DialogTitle>状態別の評価倍率</DialogTitle>
        <DialogDescription id="mult-desc">基準相場に掛けて評価額を出します（例: 基準10,000円・B 85% → 8,500円）。</DialogDescription>
        <ul className="mt-3 space-y-2">
          {VALUATION_GRADES.map((g) => (
            <li key={g} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-bold">{g}</span>
                <span className="ml-1 text-xs text-muted-foreground">{GRADE_DESCRIPTION[g]}</span>
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={MULTIPLIER_MIN}
                max={MULTIPLIER_MAX}
                aria-label={`${g}の倍率（%）`}
                value={draft[g]}
                onChange={(e) => setDraft({ ...draft, [g]: e.target.value })}
                className="h-11 w-24 rounded-md border bg-input px-3 text-right text-sm"
                data-testid={`mult-${g}`}
              />
              <span className="text-sm">%</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-muted-foreground">A+・AはA、B+・BはB、CはCとして計算します。状態が未設定のカードはA（補正なし）です。</p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setDraft(Object.fromEntries(VALUATION_GRADES.map((g) => [g, String(DEFAULT_MULTIPLIERS[g])])))} data-testid="mult-reset">
            初期値に戻す
          </Button>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                キャンセル
              </Button>
            </DialogClose>
            <Button type="button" onClick={() => void save()} disabled={busy} data-testid="mult-save">
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
