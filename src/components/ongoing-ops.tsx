"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { KIND_LABEL, kindOf, myApplication } from "@/lib/lottery-flow";
import { useBusy } from "@/lib/use-busy";
import type { Lottery } from "@/types/domain";

/**
 * 継続抽選・招待制販売の状態変更（詳細画面）。リセット・失効が確定したときだけ、手動で応募を解除して再応募の候補（要チェック）に戻す。
 * 当選・招待の到着は通常の「当選」で記録する（当選タブへ移る）。リセットが確定していない間は応募状態を勝手に解除しない。
 */
export function OngoingOps({ lottery }: { lottery: Lottery }) {
  const { data, profile, actions } = useApp();
  const [confirm, setConfirm] = useState(false);
  const [busy, run] = useBusy();
  const kind = kindOf(lottery);
  const mine = myApplication(data, lottery.id, profile.id);
  if (kind === "normal" || !mine || mine.result !== "pending") return null;
  const acc = mine.accountId;
  const word = kind === "invite" ? "リクエストの失効・再申請" : "リセット";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="ongoing-ops">
        <span className="rounded border border-info px-1.5 py-0.5 text-info">{KIND_LABEL[kind]}</span>
        {lottery.validUntil && <span className="text-muted-foreground">有効期限 {lottery.validUntil.slice(5).replace("-", "/")}</span>}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(true)} data-testid="ongoing-reset">
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {word}を記録
        </Button>
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogTitle>{word}を記録しますか？</DialogTitle>
          <DialogDescription>
            {profile.label}の応募を取り消して、再応募の候補（要チェック）に戻します。これまでの応募・当選の履歴は消えません。リセットや失効が確定しているときだけ記録してください。
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">キャンセル</Button>
            </DialogClose>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setConfirm(false);
                  const res = await actions.setApplied(lottery.id, acc, false);
                  if (res.ok) await actions.setManaged(lottery.id, true);
                })
              }
            >
              記録する
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
