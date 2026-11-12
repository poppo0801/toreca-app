"use client";

import { useRef, useState } from "react";
import { opKeeper, recoverUncertain } from "@/lib/operation-id";
import { useApp } from "@/components/app-provider";
import { StoreMultiPicker, type NewStoreDraft } from "@/components/store-multi-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { Lottery } from "@/types/domain";

/**
 * 同系列の他店舗へ複製。店舗ごとに独立した抽選を作り（1トランザクション。1店舗でも失敗すれば全体を取り消す）、元と複製先を1つの抽選グループ・同じキャンペーンにまとめる。
 * 応募・当落・メモは複製しない。すでに同じ店舗に同じ内容の抽選がある店舗は作らず、結果に表示する。店舗マスターに無い店舗は、この画面で追加できる（仮登録。同名の既存店舗はそれを使う）。
 * 実際にその店舗で開催されるかは、利用者が確認してから登録する（過去の開催店舗は候補にすぎない）。
 */
export function DuplicateDialog({ lottery, open, onOpenChange }: { lottery: Lottery; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, actions, reload } = useApp();
  const ops = useRef(opKeeper()); // 同じ内容の再送には同じ操作ID（二重に作らない）
  const chain = data.chains.find((c) => c.id === lottery.chainId);
  const taken = new Set(data.lotteries.filter((l) => lottery.campaignId && l.campaignId === lottery.campaignId).map((l) => l.storeId));
  taken.add(lottery.storeId);
  const candidates = data.stores.filter((s) => s.chainId === lottery.chainId && !s.archived && !taken.has(s.id));
  const sourceStore = data.stores.find((s) => s.id === lottery.storeId);
  const [picked, setPicked] = useState<string[]>([]);
  const [newStores, setNewStores] = useState<NewStoreDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ created: number; skipped: { storeName: string; reason: string }[] } | null>(null);
  const total = picked.length + newStores.length;

  const submit = async () => {
    if (busy || total === 0) return;
    setBusy(true);
    setError(null);
    const opId = ops.current.idFor(JSON.stringify([lottery.id, picked, newStores]));
    let res = await actions.duplicateLottery(lottery.id, picked, { newStores, group: true, opId });
    if (!res.ok && res.uncertain) {
      // 通信が途切れた: 複製されたか分からない。失敗と断定せず、操作IDで結果を確認する
      const rec = await recoverUncertain((id) => actions.lotteryOperationResult(id), opId);
      if (rec.state === "done") {
        const fresh = await reload().catch(() => null);
        res = { ok: true, data: fresh ?? data, createdIds: rec.result.ids };
      } else {
        setBusy(false);
        return setError(rec.state === "not_done" ? "通信が途切れました。確認したところ、複製されていませんでした。もう一度押してください（二重には登録されません）。" : "通信が途切れ、複製されたか確認できませんでした。通信が回復してから、もう一度押してください（複製済みなら二重には登録されません）。");
      }
    }
    setBusy(false);
    if (!res.ok) return setError(res.error);
    ops.current.reset();
    const skipped = res.skipped ?? [];
    if (skipped.length === 0) return onOpenChange(false);
    setDone({ created: res.createdIds?.length ?? 0, skipped });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-y-auto">
        <DialogTitle>他店舗に複製</DialogTitle>
        <DialogDescription>選んだ店舗ごとに、同じ内容の抽選を登録します（応募・当落は引き継ぎません）。</DialogDescription>
        {done ? (
          <div className="mt-3 space-y-2 text-sm" data-testid="duplicate-result">
            <p>{done.created}店舗に複製しました。</p>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {done.skipped.map((s) => (
                <li key={s.storeName}>
                  {s.storeName}: {s.reason}（作りませんでした）
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button onClick={() => onOpenChange(false)}>閉じる</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-3">
              <StoreMultiPicker
                chainName={chain?.name ?? ""}
                candidates={candidates}
                picked={picked}
                onPick={setPicked}
                newStores={newStores}
                onNewStores={setNewStores}
                blockedNames={sourceStore ? [sourceStore.name] : []}
              />
            </div>
            {error && (
              <p role="alert" className="mt-2 text-sm text-danger">
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="outline">キャンセル</Button>
              </DialogClose>
              <Button onClick={submit} disabled={busy || total === 0} data-testid="duplicate-submit">
                {busy ? "複製中…" : `${total}店舗に複製`}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
