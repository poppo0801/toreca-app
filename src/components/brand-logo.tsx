import { APP_NAME, APP_SUBTITLE } from "@/lib/brand";
import { LOGO_DARK, LOGO_LIGHT, logoMarkInner } from "@/lib/brand-svg";
import { cn } from "@/lib/utils";

/** ロゴマーク（ライト・ダークで線色を切り替える。ダークは .dark の祖先で切替） */
export function LogoMark({ className }: { className?: string }) {
  return (
    <>
      <svg viewBox="-50 -50 100 100" aria-hidden="true" className={cn("dark:hidden", className)} dangerouslySetInnerHTML={{ __html: logoMarkInner(LOGO_LIGHT) }} />
      <svg viewBox="-50 -50 100 100" aria-hidden="true" className={cn("hidden dark:block", className)} dangerouslySetInnerHTML={{ __html: logoMarkInner(LOGO_DARK) }} />
    </>
  );
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
