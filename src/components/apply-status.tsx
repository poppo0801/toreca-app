"use client";

import { useState } from "react";
import { Check, Circle } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { StatusIcon } from "@/components/status-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { deadlineBadge, type DeadlineBadge } from "@/lib/datetime";
import { DEADLINE_TONE_CLASS } from "@/lib/lottery-labels";
import { applyControlFor, markLabel, profileMarks } from "@/lib/lottery-summary";
import { formatItem } from "@/lib/lottery-view";
import { useBusy } from "@/lib/use-busy";
import { cn } from "@/lib/utils";
import type { FlexibleDate, Lottery } from "@/types/domain";

/** 応募締切の残り時間バッジ（締切の3日前・24時間前で色が変わる）。締切が不明なら出さない */
export function DeadlineBadgeView({ badge, className }: { badge: DeadlineBadge | null; className?: string }) {
  if (!badge) return null;
  return (
    <span
      data-testid="deadline-badge"
      data-tone={badge.tone}
      title={badge.dateOnly ? "締切の時刻は未確認です（日付だけで計算）" : undefined}
      className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-md border px-1.5 py-1 text-xs font-bold leading-none", DEADLINE_TONE_CLASS[badge.tone], className)}
    >
      {badge.label}
    </span>
  );
}

export function useDeadlineBadge(deadline: FlexibleDate): DeadlineBadge | null {
  const { now } = useApp();
  return deadlineBadge(deadline, now);
}

/**
 * プロフィール別の応募状況（表示専用）。A ✓　B ○　C ✓ のように小さく横並びにする。
 * タップしても状態は変わらない。操作は現在のプロフィール専用の MyApplyButton だけで行う。
 */
export function ApplyStatusRow({ lottery, className }: { lottery: Lottery; className?: string }) {
  const { data, now, profile } = useApp();
  const marks = profileMarks(data, lottery, now);
  if (marks.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1", className)} data-testid="apply-status" aria-label="ユーザー別の応募状況">
      {marks.map((m) => {
        const owner = data.profiles.find((p) => p.id === m.profileId);
        if (!owner) return null;
        const label = markLabel(m);
        const mine = owner.id === profile.id;
        return (
          <span
            key={m.accountId}
            role="img"
            aria-label={`${owner.label}: ${label}`}
            title={`${owner.label}: ${label}（${m.reason}）`}
            data-status={m.status}
            data-result={m.result}
            data-account={m.accountId}
            className={cn("inline-flex items-center gap-0.5", mine && "rounded-full bg-muted/70 pr-1", m.status !== "applied" && "opacity-80")}
          >
            <ProfileAvatar profile={owner} size="xs" />
            {m.status === "applied" && m.result === "won" ? (
              <span className="text-[11px] font-bold leading-none text-success">当選</span>
            ) : m.status === "applied" && m.result === "lost" ? (
              <span className="text-[11px] leading-none text-muted-foreground">落選</span>
            ) : (
              <StatusIcon status={m.status} className="size-3.5" />
            )}
          </span>
        );
      })}
    </span>
  );
}

/**
 * 現在のプロフィール専用の応募操作。押すと、現在のプロフィールの応募状態だけが変わる（他のプロフィールは変えられない）。
 * 応募済みの解除は確認つき。希望商品を1つ選んで応募する抽選は、商品を選んでから応募済みにする。
 */
export function MyApplyButton({ lottery, compact = false, className }: { lottery: Lottery; /** シンプル表示用: 文字なしの丸いボタン（✓=応募済み／○=未応募） */ compact?: boolean; className?: string }) {
  const { data, now, profile, actions } = useApp();
  const [choosing, setChoosing] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [busy, runBusy] = useBusy();
  const [error, setError] = useState<string | null>(null);
  const control = applyControlFor(data, lottery, profile.id, now);
  if (control.kind === "none") return null;

  const run = (applied: boolean, itemId?: string) =>
    runBusy(async () => {
      setError(null);
      const res = await actions.setApplied(lottery.id, control.accountId, applied, itemId);
      if (res && !res.ok) setError(res.error);
    });

  if (control.kind === "blocked") {
    return (
      <span data-testid="my-apply" data-state="blocked" className={cn("inline-flex min-h-8 items-center whitespace-nowrap rounded-full border px-2 text-xs text-muted-foreground", className)} title={`${profile.label}: ${control.label}`}>
        {control.label}
      </span>
    );
  }
  const applied = control.kind === "applied";
  return (
    <>
      <button
        type="button"
        data-testid="my-apply"
        data-state={applied ? "applied" : "unapplied"}
        data-account={control.accountId}
        aria-pressed={applied}
        aria-label={applied ? `${profile.label}は応募済み${control.canUndo ? "（解除できます）" : ""}` : `${profile.label}を応募済みにする`}
        disabled={busy || (applied && !control.canUndo)}
        onClick={() => {
          if (applied) setConfirmUndo(true);
          else if (control.kind === "apply" && control.needsChoice) setChoosing(true);
          else void run(true);
        }}
        className={cn(
          "inline-flex min-h-9 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border text-xs font-bold disabled:opacity-80",
          compact ? "size-10" : "px-2.5",
          applied && compact ? "border-success/60 bg-success/10 text-success" : !applied && compact ? "border-primary bg-card text-primary" : applied ? "border-success/60 bg-success/10 text-success" : "border-primary bg-primary text-primary-foreground",
          className,
        )}
      >
        {applied ? <Check className="size-4" strokeWidth={2.6} aria-hidden="true" /> : compact ? <Circle className="size-5" strokeWidth={2.6} aria-hidden="true" /> : null}
        {!compact && (applied ? "応募済み" : "応募済みにする")}
      </button>
      {error && (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}
      <Dialog open={choosing} onOpenChange={setChoosing}>
        <DialogContent>
          <DialogTitle>応募する商品を選択</DialogTitle>
          <DialogDescription>この抽選は、複数商品から希望の1つを選んで応募します。{profile.label}の応募として記録されます。</DialogDescription>
          <ul className="mt-3 space-y-1.5">
            {lottery.items.map((it) => (
              <li key={it.id}>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={async () => {
                    setChoosing(false);
                    if (it.id) await run(true, it.id);
                  }}
                >
                  {formatItem(it, data.products.find((p) => p.id === it.productId))}
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmUndo} onOpenChange={setConfirmUndo}>
        <DialogContent>
          <DialogTitle>{profile.label}の応募済みを解除しますか？</DialogTitle>
          <DialogDescription>応募した記録を取り消します。他のユーザーの応募状況は変わりません。</DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmUndo(false)}>
              キャンセル
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                setConfirmUndo(false);
                await run(false);
              }}
            >
              解除する
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
