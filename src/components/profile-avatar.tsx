import { Bird, Cat, Clover, Crown, Dog, Fish, Flame, Flower2, Gamepad2, Gem, Ghost, Heart, Leaf, Moon, Music, Rabbit, Rocket, Snowflake, Star, Sun, Trophy, Turtle, Umbrella, Zap, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Profile, ProfileColor } from "@/types/domain";

const COLOR_CLASS: Record<ProfileColor, string> = {
  blue: "bg-p-blue",
  green: "bg-p-green",
  purple: "bg-p-purple",
  pink: "bg-p-pink",
  teal: "bg-p-teal",
};

/** アイコンのマーク。"initial" は表示名の頭文字（色だけに依存せず、マークまたは文字で識別できる）。 */
export const ICON_MARKS: Record<string, { label: string; icon: LucideIcon | null }> = {
  initial: { label: "頭文字", icon: null },
  star: { label: "星", icon: Star },
  heart: { label: "ハート", icon: Heart },
  zap: { label: "いなずま", icon: Zap },
  flame: { label: "ほのお", icon: Flame },
  leaf: { label: "はっぱ", icon: Leaf },
  moon: { label: "つき", icon: Moon },
  sun: { label: "たいよう", icon: Sun },
  crown: { label: "おうかん", icon: Crown },
  gem: { label: "ほうせき", icon: Gem },
  ghost: { label: "おばけ", icon: Ghost },
  cat: { label: "ねこ", icon: Cat },
  // Stage 5I で追加（既存のキーは変えない）
  bird: { label: "とり", icon: Bird },
  dog: { label: "いぬ", icon: Dog },
  fish: { label: "さかな", icon: Fish },
  rabbit: { label: "うさぎ", icon: Rabbit },
  turtle: { label: "かめ", icon: Turtle },
  flower: { label: "はな", icon: Flower2 },
  clover: { label: "クローバー", icon: Clover },
  music: { label: "おんぷ", icon: Music },
  game: { label: "ゲーム", icon: Gamepad2 },
  rocket: { label: "ロケット", icon: Rocket },
  trophy: { label: "トロフィー", icon: Trophy },
  snow: { label: "ゆき", icon: Snowflake },
  umbrella: { label: "かさ", icon: Umbrella },
};

/** 自由色の背景に対して読みやすい文字色（白/黒）を選ぶ */
export function readableOn(hex: string): "#ffffff" | "#111111" {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#111111" : "#ffffff";
}

type AvatarProfile = Pick<Profile, "color" | "initial" | "label"> & Partial<Pick<Profile, "colorHex" | "iconMark">>;

/** プロフィール識別用の丸アイコン。色とマーク（または頭文字）を表示する。 */
export function ProfileAvatar({
  profile,
  size = "md",
  className,
}: {
  profile: AvatarProfile;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  const mark = ICON_MARKS[profile.iconMark ?? "initial"] ?? ICON_MARKS.initial;
  const Icon = mark.icon;
  const hex = profile.colorHex && /^#[0-9a-fA-F]{6}$/.test(profile.colorHex) ? profile.colorHex : null;
  return (
    <span
      aria-hidden="true"
      style={hex ? { backgroundColor: hex, color: readableOn(hex) } : undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-bold",
        !hex && "text-white dark:text-black",
        size === "xs" ? "size-5 text-[10px]" : size === "sm" ? "size-6 text-xs" : "size-8 text-sm",
        !hex && COLOR_CLASS[profile.color],
        className,
      )}
    >
      {Icon ? <Icon className={size === "md" ? "size-4" : "size-3"} strokeWidth={2.5} /> : profile.initial}
    </span>
  );
}
