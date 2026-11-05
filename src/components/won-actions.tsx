"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { hasSeparateSteps, wonProgress } from "@/lib/lottery-flow";
import { ownerIdOf, scopedApplications, scopeSet } from "@/lib/profile-link";
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
export function WonRecordButtons({ lottery, app, ownerLabel }: { lottery: Lottery; app: Application; ownerLabel?: string }) {
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
          {ownerLabel ? `${ownerLabel}の記録として、` : ""}{p.label}。{confirm === "purchase" ? "購入" : "受取"}の期間より前です。履歴の補正などで記録する場合のみ「記録する」を押してください。
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
 * 当選タブのカード下段。対象は「現在のユーザー＋紐づくサブ」の当選で、当選したユーザーごとに1行（アイコン・次の手続きの期限・記録ボタン）を出す。
 * 購入・受取の記録は、その行のユーザー（応募の所有者）の記録として保存される。当選者が複数でも抽選カードは1枚のまま。
 * 世帯内の他のメインユーザー・紐づいていないサブの当選は出さない。
 */
export function WonRow({ lottery }: { lottery: Lottery }) {
  const { data, now, profile } = useApp();
  const scope = scopeSet(data.profiles, profile.id);
  const idx = (a: Application) => data.profiles.findIndex((p) => p.id === ownerIdOf(data, a));
  const wonApps = scopedApplications(data, lottery.id, scope)
    .filter((a) => a.result === "won")
    .sort((a, b) => Number(ownerIdOf(data, b) === profile.id) - Number(ownerIdOf(data, a) === profile.id) || idx(a) - idx(b));
  if (wonApps.length === 0) return null;
  // 複数のユーザーが当選しているときは、誰の記録かを名前でも示す（アイコンの色だけに頼らない）
  const multi = wonApps.length > 1 || ownerIdOf(data, wonApps[0]) !== profile.id;

  return (
    <div className="border-t" data-testid="won-row">
      {wonApps.map((a, i) => {
        const owner = data.profiles.find((x) => x.id === ownerIdOf(data, a));
        const p = wonProgress(lottery, a, now);
        const done = a.fulfillment === "purchased";
        const bought = a.fulfillment === "procedure_done";
        return (
          <div key={a.id} className={cn("flex items-center gap-2 px-2.5 py-1.5", i > 0 && "border-t border-dashed")} data-testid="won-item" data-owner={owner?.id}>
            {owner && (
              <span className="relative inline-flex shrink-0 items-center gap-1" title={`${owner.label}: 当選${done ? "・受取済み" : bought ? "・購入手続き済み" : ""}`} data-won-done={done || undefined}>
                <ProfileAvatar profile={owner} size="xs" />
                {multi && <span className="max-w-[4rem] truncate text-[11px] text-muted-foreground">{owner.label}</span>}
                {done && <Check className="absolute -bottom-1 -left-1 size-3 rounded-full bg-success p-px text-background" strokeWidth={3} aria-hidden="true" />}
              </span>
            )}
            <span className={cn("min-w-0 flex-1 truncate text-xs", TONE[p.status])} data-testid="won-label" data-status={p.status}>
              {p.label}
            </span>
            <WonRecordButtons lottery={lottery} app={a} ownerLabel={multi ? owner?.label : undefined} />
          </div>
        );
      })}
    </div>
  );
}
