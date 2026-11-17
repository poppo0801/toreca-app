"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Settings } from "lucide-react";
import { AiJobsProvider } from "@/components/ai-jobs-provider";
import { AppProvider, useApp } from "@/components/app-provider";
import { ResilienceWatcher } from "@/components/resilience-watcher";
import { InputReveal } from "@/components/input-reveal";
import { BrandLogo } from "@/components/brand-logo";
import { NotificationBell } from "@/components/notification-bell";
import { iconOf } from "@/components/page-heading";
import { ProfileChip } from "@/components/profile-switcher";
import { MenuButton, NavMenuSheet } from "@/components/nav-menu";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";
import { activeNavId, resolveNavConfig, type NavItem } from "@/lib/profile-settings";
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
  // 下部メニューの構成（プロフィール別の保存値を、使える機能・権限で補正して使う。管理者専用の機能は管理者だけ）
  const nav = resolveNavConfig(settings, { isAdmin: profile.isAdmin === true, supabase: IS_SUPABASE_MODE });
  const activeId = activeNavId(pathname);
  const settingsActive = pathname.startsWith("/settings");
  // ページを移ったら、スクロール領域を先頭へ戻す（ページ全体のスクロールではないため、自動では戻らない）
  useEffect(() => {
    document.getElementById("app-scroll")?.scrollTo({ top: 0 });
  }, [pathname]);
  const menuMode = nav.mode === "four_menu";
  const slots = nav.direct.length + (menuMode ? 1 : 0);

  const link = (n: NavItem, cls: string, activeCls: string, idleCls: string, icon: string) => {
    const Icon = iconOf(n.id);
    const active = activeId === n.id;
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
            {menuMode && <MenuButton quick={nav.quick} active={false} onOpenMenu={() => setMore(true)} className="flex flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground" />}
          </div>
        </nav>
        {/* PC: 同じ下部メニュー（入れ物の最下段）に、利用できるすべての機能をアイコン＋名称で並べる（左サイドメニューは廃止）。位置の仕組みはモバイルと共通 */}
        <nav aria-label="メイン" data-testid="bottom-nav-pc" className="app-nav relative z-30 hidden shrink-0 border-t bg-header after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-40 after:bg-header after:content-[''] pb-[max(0px,calc(env(safe-area-inset-bottom)-0.5rem))] px-safe md:block">
          <div className="mx-auto flex h-14 max-w-5xl items-stretch justify-center px-3">
            {nav.direct.map((n) => link(n, "flex min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-xs hover:bg-muted/60", "font-bold text-primary-ink", "text-muted-foreground", "size-5"))}
            {menuMode && <MenuButton quick={nav.quick} active={false} onOpenMenu={() => setMore(true)} testId="nav-more-pc" className="flex min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-xs text-muted-foreground hover:bg-muted/60" />}
          </div>
        </nav>
        <NavMenuSheet open={more} onOpenChange={setMore} items={nav.menu} activeId={activeId} />
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
        <InputReveal />
      </AiJobsProvider>
    </AppProvider>
  );
}
