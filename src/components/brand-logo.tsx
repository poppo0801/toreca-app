import { APP_NAME, APP_SUBTITLE } from "@/lib/brand";
import { cn } from "@/lib/utils";

/** ロゴマーク（ユーザー提供の原本画像 toremane_icon.jpg から生成した画像。ライト・ダーク共通の濃色の角丸アイコン） */
export function LogoMark({ className }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- 小さな固定画像。最適化は不要
  return <img src="/icons/v2/mark-96.png" alt="" width={48} height={48} aria-hidden="true" draggable={false} className={cn("rounded-[22%]", className)} />;
}

/** ロゴ＋「トレマネ」（＋英語の副題）。ヘッダーは横並び、ログイン画面は縦並び */
export function BrandLogo({ variant = "inline", className }: { variant?: "inline" | "stacked"; className?: string }) {
  if (variant === "stacked") {
    return (
      <div className={cn("flex flex-col items-center gap-1", className)}>
        <LogoMark className="size-16" />
        <span className="text-2xl font-extrabold tracking-wide">{APP_NAME}</span>
        <span className="text-xs tracking-[0.2em] text-muted-foreground">{APP_SUBTITLE}</span>
      </div>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} data-testid="brand">
      <LogoMark className="size-6" />
      <span className="text-sm font-extrabold leading-none tracking-wide">{APP_NAME}</span>
      <span className="hidden text-[10px] leading-none text-muted-foreground sm:inline">{APP_SUBTITLE}</span>
    </span>
  );
}
