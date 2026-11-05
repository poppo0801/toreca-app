"use client";

import { useState } from "react";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { needsResultConfirm, resultCountdown } from "@/lib/lottery-flow";
import { ownerIdOf, scopedApplications, scopeSet } from "@/lib/profile-link";
import { useBusy } from "@/lib/use-busy";
import { cn } from "@/lib/utils";
import type { Application, Lottery } from "@/types/domain";

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
 * 応募済みタブの当落ボタン。対象は「現在のユーザー＋紐づくサブ」の応募で、記録は必ずその応募の所有ユーザーに保存される
 * （メイン A が サブ C の結果を入力しても、C の記録になる）。複数のユーザーが応募していれば、ユーザーごとに行を分けて表示する。
 * 発表前でも記録できるが、確認ダイアログを出して誤登録を防ぐ。複数商品の抽選は商品ごとの入力が必要なので詳細を開く。
 */
export function ResultButtons({ lottery, compact = false, onOpenDetail }: { lottery: Lottery; compact?: boolean; onOpenDetail?: () => void }) {
  const { data, profile } = useApp();
  const scope = scopeSet(data.profiles, profile.id);
  const apps = scopedApplications(data, lottery.id, scope).sort((a, b) => Number(ownerIdOf(data, b) === profile.id) - Number(ownerIdOf(data, a) === profile.id));
  if (apps.length === 0) return <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">未応募</span>;
  if (apps.length === 1) return <ResultRow lottery={lottery} app={apps[0]} compact={compact} onOpenDetail={onOpenDetail} labeled={ownerIdOf(data, apps[0]) !== profile.id} />;
  return (
    <span className="flex shrink-0 flex-col items-end gap-1" data-testid="result-rows">
      {apps.map((a) => (
        <span key={a.id} className="inline-flex items-center gap-1.5" data-testid="result-row" data-owner={ownerIdOf(data, a)}>
          <ResultRow lottery={lottery} app={a} compact={compact} onOpenDetail={onOpenDetail} labeled />
        </span>
      ))}
    </span>
  );
}

/** 1人ぶんの応募の当落。labeled=誰の記録か（アイコン＋名前）を明示する */
function ResultRow({ lottery, app: mine, compact, onOpenDetail, labeled }: { lottery: Lottery; app: Application; compact: boolean; onOpenDetail?: () => void; labeled: boolean }) {
  const { data, now, actions } = useApp();
  const [busy, run] = useBusy();
  const [confirm, setConfirm] = useState<"won" | "lost" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = compact ? "min-h-9 px-2.5 text-xs" : "px-3";
  const owner = data.profiles.find((p) => p.id === ownerIdOf(data, mine));
  const who = owner?.label ?? "";
  const tag = labeled && owner ? (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground" data-testid="result-owner" data-owner={owner.id}>
      <ProfileAvatar profile={owner} size="xs" className="size-[18px] text-[9px]" />
      <span className="max-w-[4.5rem] truncate">{who}</span>
    </span>
  ) : null;

  if (mine.result === "won" || mine.result === "lost") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1">
        {tag}
        <span data-testid="my-result" className={cn("inline-flex shrink-0 items-center rounded-full border px-2.5 py-1.5 text-xs font-bold", mine.result === "won" ? WON_CLASS : LOST_CLASS)}>
          {mine.result === "won" ? "当選" : "落選"}
        </span>
      </span>
    );
  }
  if (lottery.multiMode !== "single") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1">
        {tag}
        <Button size="sm" variant="outline" onClick={onOpenDetail} data-testid="result-open-detail">
          結果を入力
        </Button>
      </span>
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
      {tag}
      <span className="inline-flex shrink-0 items-center gap-1.5" role="group" aria-label={`${who}の当落を記録`}>
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
          <DialogDescription>この抽選はまだ発表日前です。{labeled ? `${who}の記録として` : ""}{confirm === "won" ? "当選" : "落選"}として記録します。誤って押した場合は詳細から「未確認」に戻せます。</DialogDescription>
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
