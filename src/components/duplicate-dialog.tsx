"use client";

import { useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { Lottery } from "@/types/domain";

/**
 * 同系列の他店舗へ複製。店舗ごとに独立した抽選レコードを作り、同じキャンペーンに関連づける。
 * 過去の開催店舗は候補にすぎず、開催事実・条件は利用者が確認する（応募・当落は複製しない）。
 */
export function DuplicateDialog({ lottery, open, onOpenChange }: { lottery: Lottery; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, actions } = useApp();
  const taken = new Set(
    data.lotteries
      .filter((l) => lottery.campaignId && l.campaignId === lottery.campaignId)
      .map((l) => l.storeId),
  );
  taken.add(lottery.storeId);
  const candidates = data.stores.filter((s) => s.chainId === lottery.chainId && !s.archived && !taken.has(s.id));
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const res = await actions.duplicateLottery(lottery.id, picked);
    setBusy(false);
    if (res.ok) onOpenChange(false);
    else setError(res.error);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogTitle>他店舗に複製</DialogTitle>
        <DialogDescription>
          選んだ店舗ごとに、同じ内容の抽選を独立して登録します。応募・当落は引き継ぎません。実際にその店舗で開催されるか確認してから登録してください。
        </DialogDescription>
        {candidates.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">複製できる同系列の店舗がありません（店舗はマスター管理で追加）。</p>
        ) : (
          <ul className="mt-3 space-y-1">
            {candidates.map((s) => (
              <li key={s.id}>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={picked.includes(s.id)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))}
                  />
                  {s.name}
                  {s.prefecture && <span className="text-xs text-muted-foreground">（{s.prefecture}）</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline">キャンセル</Button>
          </DialogClose>
          <Button onClick={submit} disabled={busy || picked.length === 0}>
            {busy ? "複製中…" : `${picked.length}店舗に複製`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
