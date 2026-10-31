"use client";

import { useState } from "react";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** 操作プロフィールの選択一覧。本人認証ではなく「誰として記録するか」の選択。 */
export function ProfileSwitcher({ className, onSelected }: { className?: string; onSelected?: () => void }) {
  const { data, profile, selectProfile } = useApp();
  return (
    <div role="radiogroup" aria-label="操作プロフィール" className={cn("flex flex-col gap-1", className)}>
      {data.profiles
        .filter((p) => p.active !== false)
        .map((p) => {
          const selected = p.id === profile.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`プロフィール ${p.label}`}
              onClick={() => {
                selectProfile(p.id);
                onSelected?.();
              }}
              className={cn(
                "flex min-h-12 items-center gap-3 rounded-md border px-3 text-left text-sm",
                selected ? "border-primary bg-muted font-medium" : "hover:bg-muted",
              )}
            >
              <ProfileAvatar profile={p} />
              <span className="flex-1">{p.label}</span>
              {selected && <span className="text-xs text-primary-ink">使用中</span>}
            </button>
          );
        })}
    </div>
  );
}

/** ヘッダー用: 現在のユーザーだけを小さく表示し、タップで切り替え画面を開く。 */
export function ProfileChip() {
  const { profile } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`ユーザー切り替え（現在: ${profile.label}）`}
        className="flex h-10 items-center gap-1.5 rounded-full px-1.5 hover:bg-muted"
      >
        <ProfileAvatar profile={profile} size="sm" />
        <span className="max-w-[5.5rem] truncate text-xs font-light" data-testid="current-profile">
          {profile.label}
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>ユーザーを切り替え</DialogTitle>
          <DialogDescription>選択はこの端末にのみ保存されます（他の端末には影響しません）。</DialogDescription>
          <ProfileSwitcher className="mt-3" onSelected={() => setOpen(false)} />
          <div className="mt-3 flex justify-end">
            <DialogClose className="min-h-10 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted">閉じる</DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
