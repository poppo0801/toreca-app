"use client";

import { useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { myApplication, needsResultConfirm, resultCountdown } from "@/lib/lottery-flow";
import { useBusy } from "@/lib/use-busy";
import { cn } from "@/lib/utils";
import type { Lottery } from "@/types/domain";

const WON_CLASS = "border-success/70 bg-success/10 text-success hover:bg-success/20";
/** 当選ボタンは主要操作のオレンジ、落選ボタンはグレー系（誤タップしやすい左右の並びは 落選｜当選） */
const WON_BUTTON_CLASS = "border-primary bg-primary text-primary-foreground hover:bg-primary/90";
const LOST_CLASS = "border-border bg-muted text-muted-foreground hover:bg-muted/70";

const TONE_CLASS = {
  normal: "text-muted-foreground",
  warn: "border-warn text-warn",
  info: "border-info bg-info/10 text-info",
  danger: "border-danger bg-danger/10 text-danger",
} as const;

/** 発表基準のバッジ（あとN日／発表期間中／結果未確認）。発表日が不明なら何も出さない */
export function ResultCountdownBadge({ lottery, className }: { lottery: Lottery; className?: string }) {
  const { now } = useApp();
  const c = resultCountdown(lottery, now);
  if (!c) return null;
  return (
    <span data-testid="result-badge" data-tone={c.tone} className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-md border px-1.5 py-1 text-xs font-bold leading-none", TONE_CLASS[c.tone], className)}>
      {c.label}
    </span>
  );
}

/**
 * 応募済みタブの当落ボタン（現在のプロフィールの応募だけが対象）。
 * 発表前でも記録できるが、確認ダイアログを出して誤登録を防ぐ。複数商品の抽選は商品ごとの入力が必要なので詳細を開く。
 */
export function ResultButtons({ lottery, compact = false, onOpenDetail }: { lottery: Lottery; compact?: boolean; onOpenDetail?: () => void }) {
  const { data, now, profile, actions } = useApp();
  const [busy, run] = useBusy();
  const [confirm, setConfirm] = useState<"won" | "lost" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = myApplication(data, lottery.id, profile.id);
  const base = compact ? "min-h-9 px-2.5 text-xs" : "px-3";

  if (!mine) return <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">未応募</span>;
  if (mine.result === "won" || mine.result === "lost") {
    return (
      <span data-testid="my-result" className={cn("inline-flex shrink-0 items-center rounded-full border px-2.5 py-1.5 text-xs font-bold", mine.result === "won" ? WON_CLASS : LOST_CLASS)}>
        {mine.result === "won" ? "当選" : "落選"}
      </span>
    );
  }
  if (lottery.multiMode !== "single") {
    return (
      <Button size="sm" variant="outline" onClick={onOpenDetail} data-testid="result-open-detail">
        結果を入力
      </Button>
    );
  }
  const exec = (r: "won" | "lost") =>
    run(async () => {
      setError(null);
      const res = await actions.setResult(mine.id, r);
      if (!res.ok) setError(res.error);
    });
  const press = (r: "won" | "lost") => (needsResultConfirm(lottery, now) ? setConfirm(r) : void exec(r));

  return (
    <>
      <span className="inline-flex shrink-0 items-center gap-1.5" role="group" aria-label={`${profile.label}の当落を記録`}>
        <Button size="sm" variant="outline" className={cn(base, LOST_CLASS)} disabled={busy} onClick={() => press("lost")} data-testid="result-lost">
          落選
        </Button>
        <Button size="sm" variant="outline" className={cn(base, WON_BUTTON_CLASS)} disabled={busy} onClick={() => press("won")} data-testid="result-won">
          当選
        </Button>
      </span>
      {error && (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogTitle>発表前ですが結果を記録しますか？</DialogTitle>
          <DialogDescription>この抽選はまだ発表日前です。{confirm === "won" ? "当選" : "落選"}として記録します。誤って押した場合は詳細から「未確認」に戻せます。</DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">キャンセル</Button>
            </DialogClose>
            <Button
              onClick={() => {
                const r = confirm;
                setConfirm(null);
                if (r) void exec(r);
              }}
            >
              記録する
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
