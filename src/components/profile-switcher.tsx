"use client";

import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { cn } from "@/lib/utils";

/** 操作プロフィール切替。本人認証ではなく「誰として記録するか」の選択。 */
export function ProfileSwitcher({ className }: { className?: string }) {
  const { data, profile, selectProfile } = useApp();
  return (
    <div
      role="radiogroup"
      aria-label="操作プロフィール"
      className={cn("flex items-center gap-1", className)}
    >
      {data.profiles.map((p) => {
        const selected = p.id === profile.id;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`プロフィール ${p.label}`}
            onClick={() => selectProfile(p.id)}
            className={cn(
              "flex size-11 items-center justify-center rounded-full",
              selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
            )}
          >
            <ProfileAvatar profile={p} />
          </button>
        );
      })}
    </div>
  );
}
