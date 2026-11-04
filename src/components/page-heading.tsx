import { Banknote, Layers, ReceiptText, Settings, Swords, Ticket, Wallet, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** メニュー項目のアイコン（下部メニュー・PCの左ナビ・ページ見出しで共通）。機能を足すときは NAV_ITEMS（profile-settings.ts）と、ここに1行ずつ足す */
export const NAV_ICON: Record<string, LucideIcon> = {
  lotteries: Ticket,
  purchases: ReceiptText,
  finance: Wallet,
  battles: Swords,
  collection: Layers,
  settings: Settings,
};
export const iconOf = (id: string): LucideIcon => NAV_ICON[id] ?? Banknote;

/** ページ見出し1行の共通の高さ（ページごとに見出しの位置がずれないよう、見出し行はすべてこの高さにそろえる） */
export const PAGE_HEADING_ROW = "flex h-9 items-center justify-between gap-2";

/**
 * ページ左上の見出し。下部メニューと同じアイコンを左に添える（メニューにない画面は icon を指定しない）。
 * 高さ・余白は増やさない（文字サイズはすべて同じ）。
 */
export function PageHeading({ navId, children, className }: { navId?: string; children: React.ReactNode; className?: string }) {
  const Icon = navId ? (NAV_ICON[navId] ?? null) : null;
  return (
    <h1 className={cn("flex min-w-0 items-center gap-1.5 text-base font-bold leading-6", className)}>
      {Icon && <Icon className="size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />}
      <span className="min-w-0 truncate">{children}</span>
    </h1>
  );
}
