"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { hasSeparateSteps, myApplication, wonProgress } from "@/lib/lottery-flow";
import { useBusy } from "@/lib/use-busy";
import { cn } from "@/lib/utils";
import type { Application, Lottery } from "@/types/domain";

const TONE: Record<string, string> = {
  overdue: "font-bold text-danger",
  open: "font-medium",
  unknown: "text-muted-foreground",
  waiting_start: "text-muted-foreground",
  done: "text-success",
};

/**
 * 現在のプロフィールの購入／受取の記録ボタン。
 *  - 購入と受取が同じ期間（通常・店頭）: 「受取を記録」だけ。
 *  - 期間を分けた抽選: 「購入を記録」→「受取を記録」の順。購入後は「✓購入済」を示す。
 *  - 通販・発送の抽選: 「購入を記録」「受取を記録」を並べて出し、押した方が「✓購入済」「✓受取済」に変わる（別々の状態）。
 * 購入記録は応募ごとに1件（受取済みにしたときに DB 関数が1件だけ作る。何度押しても二重計上しない）。期間前に押したときは確認する（履歴の補正は期間外でも可能）。
 */
export function WonRecordButtons({ lottery, app }: { lottery: Lottery; app: Application }) {
  const { now, actions } = useApp();
  const [busy, run] = useBusy();
  const [confirm, setConfirm] = useState<"purchase" | "receive" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const p = wonProgress(lottery, app, now);
  const split = hasSeparateSteps(lottery);
  const shipping = lottery.receiveMethod === "shipping";

  const exec = (kind: "purchase" | "receive") =>
    run(async () => {
      setError(null);
      const res = await actions.setFulfillment(app.id, kind === "purchase" ? "procedure_done" : "purchased");
      if (!res.ok) setError(res.error);
    });
  const press = (kind: "purchase" | "receive") => (p.status === "waiting_start" ? setConfirm(kind) : void exec(kind));
  const confirmDialog = (
    <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
      <DialogContent>
        <DialogTitle>期間前ですが記録しますか？</DialogTitle>
        <DialogDescription>
          {p.label}。{confirm === "purchase" ? "購入" : "受取"}の期間より前です。履歴の補正などで記録する場合のみ「記録する」を押してください。
        </DialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline">キャンセル</Button>
          </DialogClose>
          <Button
            onClick={() => {
              const k = confirm;
              setConfirm(null);
              if (k) void exec(k);
            }}
          >
            記録する
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  const doneChip = (label: string, testId: string) => (
    <span data-testid={testId} className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-success/60 bg-success/10 px-2 py-1 text-xs font-bold text-success">
      <Check className="size-3.5" strokeWidth={2.6} aria-hidden="true" />
      {label}
    </span>
  );
  // 通販・発送: 購入と受取の両方の操作を並べる。押した方が「✓購入済」「✓受取済」になる（現在のプロフィールの応募だけ）
  if (shipping) {
    const purchased = app.fulfillment !== "none";
    const received = app.fulfillment === "purchased";
    return (
      <>
        <span className="inline-flex shrink-0 items-center gap-1.5" data-testid="ship-steps">
          {purchased ? (
            doneChip("購入済", "won-purchased")
          ) : (
            <Button size="sm" disabled={busy} onClick={() => press("purchase")} data-testid="record-purchase">
              購入を記録
            </Button>
          )}
          {received ? (
            doneChip("受取済", "won-done")
          ) : (
            <Button size="sm" variant={purchased ? "default" : "outline"} disabled={busy} onClick={() => press("receive")} data-testid="record-receive">
              受取を記録
            </Button>
          )}
        </span>
        {error && (
          <span role="alert" className="sr-only">
            {error}
          </span>
        )}
        {confirmDialog}
      </>
    );
  }
  if (p.stage === "done") return doneChip("受取済", "won-done");
  return (
    <>
      <span className="inline-flex shrink-0 items-center gap-1.5">
        {split && p.stage === "receive" && doneChip("購入済", "won-purchased")}
        <Button size="sm" disabled={busy} onClick={() => press(p.stage === "purchase" ? "purchase" : "receive")} data-testid={p.stage === "purchase" ? "record-purchase" : "record-receive"}>
          {p.stage === "purchase" ? "購入を記録" : "受取を記録"}
        </Button>
      </span>
      {error && (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}
      {confirmDialog}
    </>
  );
}

/**
 * 当選タブのカード下段（1行）。当選したプロフィールの状況を小さく並べ、次の手続きの期限と、現在のプロフィール用の記録ボタンを出す。
 * 他のプロフィールの操作ボタンは並べない（閲覧のみ）。当選者が複数でも抽選カードは1枚のまま。
 */
export function WonRow({ lottery }: { lottery: Lottery }) {
  const { data, now, profile } = useApp();
  const idx = (accountId: string) => data.profiles.findIndex((p) => p.id === data.accounts.find((x) => x.id === accountId)?.profileId);
  const wonApps = data.applications.filter((a) => a.lotteryId === lottery.id && a.state === "applied" && a.result === "won").sort((a, b) => idx(a.accountId) - idx(b.accountId));
  const mine = myApplication(data, lottery.id, profile.id);
  const myWon = mine?.result === "won" ? mine : undefined;
  const shown = myWon ?? wonApps[0];
  if (!shown) return null;
  const p = wonProgress(lottery, shown, now);

  return (
    <div className="flex items-center gap-2 border-t px-2.5 py-1.5" data-testid="won-row">
      <span className="flex shrink-0 items-center gap-1" aria-label="当選したユーザー">
        {wonApps.map((a) => {
          const owner = data.profiles.find((x) => x.id === data.accounts.find((acc) => acc.id === a.accountId)?.profileId);
          if (!owner) return null;
          const done = a.fulfillment === "purchased";
          const bought = a.fulfillment === "procedure_done";
          return (
            <span key={a.id} className="relative inline-flex" title={`${owner.label}: 当選${done ? "・受取済み" : bought ? "・購入手続き済み" : ""}`} data-won-done={done || undefined}>
              <ProfileAvatar profile={owner} size="xs" />
              {done && <Check className="absolute -bottom-1 -right-1 size-3 rounded-full bg-success p-px text-background" strokeWidth={3} aria-hidden="true" />}
            </span>
          );
        })}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-xs", TONE[p.status])} data-testid="won-label" data-status={p.status}>
        {myWon || wonApps.length === 1 ? p.label : `${p.label}（他のユーザー）`}
      </span>
      {myWon && <WonRecordButtons lottery={lottery} app={myWon} />}
    </div>
  );
}
