"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Ellipsis, Settings } from "lucide-react";
import { AiJobsProvider } from "@/components/ai-jobs-provider";
import { AppProvider, useApp } from "@/components/app-provider";
import { ResilienceWatcher } from "@/components/resilience-watcher";
import { BrandLogo } from "@/components/brand-logo";
import { NotificationBell } from "@/components/notification-bell";
import { iconOf } from "@/components/page-heading";
import { ProfileChip } from "@/components/profile-switcher";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";
import { availableNav, isNavActive, resolveNav, type NavItem } from "@/lib/profile-settings";
import { cn } from "@/lib/utils";

/** プロフィールに保存されたテーマを、そのプロフィールに切り替えたときに適用する */
function useProfileTheme() {
  const { settings, profile } = useApp();
  const { setTheme } = useTheme();
  const saved = settings.theme;
  useEffect(() => {
    if (saved) setTheme(saved);
    // プロフィールを切り替えたときだけ反映する（利用者が画面上で変えた直後は、保存と同時に反映される）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { profile, notice, dismissNotice, settings } = useApp();
  const [more, setMore] = useState(false);
  useKeyboardInset();
  useProfileTheme();
  const nav = resolveNav(settings.nav);
  const all = availableNav();
  const settingsActive = pathname.startsWith("/settings");
  // ページを移ったら、スクロール領域を先頭へ戻す（ページ全体のスクロールではないため、自動では戻らない）
  useEffect(() => {
    document.getElementById("app-scroll")?.scrollTo({ top: 0 });
  }, [pathname]);
  const slots = nav.direct.length + (nav.more.length > 0 ? 1 : 0);

  const link = (n: NavItem, cls: string, activeCls: string, idleCls: string, icon: string) => {
    const Icon = iconOf(n.id);
    const active = isNavActive(n, pathname);
    return (
      <Link key={n.id} href={n.href} aria-current={active ? "page" : undefined} data-nav={n.id} className={cn(cls, active ? activeCls : idleCls)} onClick={() => setMore(false)}>
        <Icon className={icon} aria-hidden="true" />
        {n.label}
      </Link>
    );
  };

  return (
    // 画面全体を固定の入れ物にして（上下左右を表示領域に固定）、中のスクロール領域だけを動かす。下部メニューは固定配置ではなく入れ物の最下段なので、
    // 表示領域の測定・補正に頼らず、常に表示領域の下端に接する（docs/stage6j-viewport.md）
    <div className="app-root flex flex-col" data-testid="app-root">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 上部ヘッダー: アプリ名(小)・通知ベル・現在のユーザー・設定（歯車）。ステータスバー/Dynamic Island分は Safe Area で確保 */}
        <header className="relative z-30 shrink-0 border-b-[3px] border-b-primary bg-header pt-safe px-safe shadow-card">
          <div className="flex h-10 items-center justify-between px-3">
            <BrandLogo />
            <div className="flex items-center gap-0.5">
              <Link
                href="/settings"
                aria-label="設定"
                aria-current={settingsActive ? "page" : undefined}
                data-testid="header-settings"
                className={cn("flex size-10 items-center justify-center rounded-md hover:bg-muted", settingsActive && "text-primary-ink")}
              >
                <Settings className="size-[18px]" aria-hidden="true" />
              </Link>
              <NotificationBell />
              <ProfileChip />
            </div>
          </div>
        </header>
        {/* スクロールするのはここだけ（ページ全体はスクロールしない）。ヘッダーと下部メニューは動かない。ゴム紐のバウンスも中だけで、メニューには伝わらない */}
        <main id="app-scroll" data-testid="app-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain [--header-h:0px] [-webkit-overflow-scrolling:touch]">
          <div className="mx-auto w-full max-w-5xl px-3 pb-6 pt-2 md:px-6 md:pb-8 md:pt-3">
          <p className="sr-only" aria-live="polite">
            現在の操作プロフィール: {profile.label}
          </p>
          {notice && (
            <div role="alert" className="mb-3 flex items-start justify-between gap-2 rounded-md border border-danger p-2 text-sm text-danger">
              <span>{notice}</span>
              <button type="button" onClick={dismissNotice} className="shrink-0 underline">
                閉じる
              </button>
            </div>
          )}
          {children}
          </div>
        </main>
        {/* モバイル: 下部メニュー（プロフィール別・最大5枠。隠れた機能があれば「その他」）。背景は下端まで伸び、操作部分はホームインジケーターの少し上 */}
        <nav aria-label="メイン" data-testid="bottom-nav" className="app-nav relative z-30 shrink-0 border-t bg-header after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-40 after:bg-header after:content-[''] pb-[max(0px,calc(env(safe-area-inset-bottom)-0.5rem))] px-safe md:hidden">
          <div className="grid h-[3.25rem]" style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }}>
            {nav.direct.map((n) => link(n, "flex flex-col items-center justify-center gap-0.5 text-[11px]", "font-bold text-primary-ink", "text-muted-foreground", "size-5"))}
            {nav.more.length > 0 && (
              <button
                type="button"
                onClick={() => setMore(true)}
                aria-haspopup="dialog"
                data-testid="nav-more"
                className={cn("flex flex-col items-center justify-center gap-0.5 text-[11px]", nav.more.some((n) => isNavActive(n, pathname)) ? "font-bold text-primary-ink" : "text-muted-foreground")}
              >
                <Ellipsis className="size-5" aria-hidden="true" />
                その他
              </button>
            )}
          </div>
        </nav>
        {/* PC: 同じ下部メニュー（入れ物の最下段）に、利用できるすべての機能をアイコン＋名称で並べる（左サイドメニューは廃止）。位置の仕組みはモバイルと共通 */}
        <nav aria-label="メイン" data-testid="bottom-nav-pc" className="app-nav relative z-30 hidden shrink-0 border-t bg-header after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-40 after:bg-header after:content-[''] pb-[max(0px,calc(env(safe-area-inset-bottom)-0.5rem))] px-safe md:block">
          <div className="mx-auto flex h-14 max-w-5xl items-stretch justify-center px-3">
            {all.map((n) => link(n, "flex min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-xs hover:bg-muted/60", "font-bold text-primary-ink", "text-muted-foreground", "size-5"))}
          </div>
        </nav>
        <Sheet open={more} onOpenChange={setMore}>
          <SheetContent data-testid="more-sheet" aria-describedby="more-desc">
            <div className="px-4 pb-2">
              <SheetTitle>その他</SheetTitle>
              <SheetDescription id="more-desc">下部メニューに表示していない機能です。</SheetDescription>
            </div>
            <SheetBody className="border-t pt-2">
              <ul className="divide-y">
                {nav.more.map((n) => {
                  const Icon = iconOf(n.id);
                  return (
                    <li key={n.id}>
                      <Link href={n.href} onClick={() => setMore(false)} data-more={n.id} className="flex min-h-12 items-center gap-3 px-1 text-sm">
                        <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
                        {n.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </SheetBody>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}

export function AppShell({ children, overlay }: { children: React.ReactNode; /** 画面の上に重ねる通知（起動時の収集結果など）。配置は持たない */ overlay?: React.ReactNode }) {
  return (
    <AppProvider>
      <AiJobsProvider>
        <Shell>{children}</Shell>
        {overlay}
        <ResilienceWatcher />
      </AiJobsProvider>
    </AppProvider>
  );
}
