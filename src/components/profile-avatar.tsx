import { cn } from "@/lib/utils";
import type { Profile, ProfileColor } from "@/types/domain";

const COLOR_CLASS: Record<ProfileColor, string> = {
  blue: "bg-p-blue",
  green: "bg-p-green",
  purple: "bg-p-purple",
  pink: "bg-p-pink",
  teal: "bg-p-teal",
};

/** プロフィール識別用の丸アイコン。色に加え頭文字を必ず表示する。 */
export function ProfileAvatar({
  profile,
  size = "md",
  className,
}: {
  profile: Pick<Profile, "color" | "initial" | "label">;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-bold text-background",
        size === "sm" ? "size-6 text-xs" : "size-8 text-sm",
        COLOR_CLASS[profile.color],
        className,
      )}
    >
      {profile.initial}
    </span>
  );
}
