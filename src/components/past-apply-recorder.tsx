"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { DateClearButton } from "@/components/ui/clearable-date";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { accountsForLottery, effectiveEventState } from "@/lib/eligibility";
import { myApplication } from "@/lib/lottery-flow";
import { formatItem } from "@/lib/lottery-view";
import { useBusy } from "@/lib/use-busy";
import type { Lottery } from "@/types/domain";

/** 締切後の抽選で、記録し忘れていた「現在のプロフィール」の応募を履歴として補正できるか */
export function canRecordPastApply(args: { eventState: Lottery["eventState"]; hasAccount: boolean; alreadyApplied: boolean }): boolean {
  return args.eventState === "closed" && args.hasAccount && !args.alreadyApplied;
}

/**
 * 締切後の応募の記録（履歴補正）。通常の応募ボタン（受付中のみ）とは別の入口で、詳細画面からだけ使える。
 * 対象は現在選択中のプロフィールだけ。実際の応募日時が分からないときは空欄のままにでき、その場合は日時なしで保存する
 * （現在日時を応募日時として偽って記録しない）。
 */
export function PastApplyRecorder({ lottery }: { lottery: Lottery }) {
  const { data, now, profile, actions } = useApp();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState("");
  const [itemId, setItemId] = useState(lottery.items[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, run] = useBusy();

  const acc = accountsForLottery(data, lottery).find((a) => a.profileId === profile.id);
  const ok = canRecordPastApply({ eventState: effectiveEventState(lottery, now), hasAccount: !!acc, alreadyApplied: !!myApplication(data, lottery.id, profile.id) });
  if (!ok || !acc) return null;
  const choose = lottery.multiMode === "choose_one";

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="past-apply-open">
        <History className="size-4" aria-hidden="true" />
        締切後の応募を記録
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>{profile.label}の応募を後から記録</DialogTitle>
          <DialogDescription>記録し忘れていた応募の履歴補正です。{profile.label}の分だけが記録され、他のユーザーの状態は変わりません。</DialogDescription>
          <div className="mt-3 space-y-3 text-sm">
            <div>
              <span className="flex items-center gap-1 text-[13px] font-medium">
                実際に応募した日時（任意）
                {at && <DateClearButton label="応募日時" onClear={() => setAt("")} className="ml-auto" />}
              </span>
              <input type="datetime-local" aria-label="実際に応募した日時" value={at} onChange={(e) => setAt(e.target.value)} className="mt-1 min-h-11 w-full rounded-md border bg-input px-2 text-sm" />
              <p className="mt-0.5 text-[11px] text-muted-foreground">不明なら空欄のまま記録できます（現在の日時は入りません）</p>
            </div>
            {choose && (
              <label className="block">
                <span className="text-[13px] font-medium">応募した商品</span>
                <select aria-label="応募した商品" value={itemId} onChange={(e) => setItemId(e.target.value)} className="mt-1 min-h-11 w-full rounded-md border bg-input px-2 text-sm">
                  {lottery.items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {formatItem(it, data.products.find((p) => p.id === it.productId))}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="outline">キャンセル</Button>
              </DialogClose>
              <Button
                disabled={busy || (choose && !itemId)}
                data-testid="past-apply-save"
                onClick={() =>
                  void run(async () => {
                    setError(null);
                    const res = await actions.setApplied(lottery.id, acc.id, true, choose ? itemId : null, { backfill: true, appliedAt: at || null });
                    if (res.ok) setOpen(false);
                    else setError(res.error);
                  })
                }
              >
                応募済みとして記録
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
