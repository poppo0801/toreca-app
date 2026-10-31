"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Banknote, Ellipsis, Layers, ReceiptText, Settings, Swords, Ticket, Wallet, type LucideIcon } from "lucide-react";
import { AiJobsProvider } from "@/components/ai-jobs-provider";
import { AppProvider, useApp } from "@/components/app-provider";
import { BrandLogo } from "@/components/brand-logo";
import { LayoutDiagnostics, useDiagEnabled } from "@/components/layout-diagnostics";
import { NotificationBell } from "@/components/notification-bell";
import { ProfileChip } from "@/components/profile-switcher";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { viewportGap } from "@/lib/viewport-gap";
import { keyboardInset, SETTLE_MS } from "@/lib/viewport-insets";
import { availableNav, isNavActive, resolveNav, type NavItem } from "@/lib/profile-settings";
import { cn } from "@/lib/utils";

/** メニュー項目のアイコン。機能を足すときは NAV_ITEMS（profile-settings.ts）と、ここに1行ずつ足す */
const NAV_ICON: Record<string, LucideIcon> = {
  lotteries: Ticket,
  purchases: ReceiptText,
  finance: Wallet,
  battles: Swords,
  collection: Layers,
};
const iconOf = (id: string) => NAV_ICON[id] ?? Banknote;

/**
 * iOS のホーム画面アプリの表示領域まわりを CSS 変数に反映する。
 *  --vp-gap  : 起動直後だけ表示領域(innerHeight)が実際の画面より低いとき、100vh との差（standalone のときだけ）。下部の固定要素の bottom をその分下げる。
 *  --kb-inset: キーボードが隠している下側の高さ。ボトムシートの bottom をその分上げる。
 * 表示領域は起動・復帰・最初の操作のあとに、イベントなしで変わることがある（実機の診断）。以前は特定のイベントの瞬間に1回だけ測っていたため、
 * 測った後に表示領域が直ると補正値だけが残り、下部メニューが画面の下へはみ出す（下半分が隠れる）危険があった。
 * そこで、これらのきっかけの後は SETTLE_MS の間フレームごとに測り直す（値が変わったときだけ書き換える。無条件の再描画はしない）。
 */
function useViewportGap() {
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia("(display-mode: standalone)");
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;left:0;top:0;width:0;height:100vh";
    document.body.appendChild(probe);
    const set = (name: string, px: number) => {
      const prev = root.style.getPropertyValue(name);
      const next = px > 0 ? `${px}px` : "";
      if (prev === next) return;
      if (next) root.style.setProperty(name, next);
      else root.style.removeProperty(name);
    };
    const measure = () => {
      const standalone = mq.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      set("--vp-gap", viewportGap(probe.getBoundingClientRect().height, window.innerHeight, standalone));
      set("--kb-inset", keyboardInset(window.innerHeight, window.visualViewport));
    };
    let until = 0;
    let raf = 0;
    const tick = () => {
      measure();
      raf = performance.now() < until ? requestAnimationFrame(tick) : 0;
    };
    const settle = () => {
      until = performance.now() + SETTLE_MS;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    settle();
    const opts = { passive: true, capture: true } as const;
    const vv = window.visualViewport;
    const onVisible = () => document.visibilityState === "visible" && settle();
    window.addEventListener("pageshow", settle);
    window.addEventListener("orientationchange", settle);
    window.addEventListener("resize", settle);
    document.addEventListener("visibilitychange", onVisible);
    vv?.addEventListener("resize", settle);
    vv?.addEventListener("scroll", measure);
    window.addEventListener("touchstart", settle, opts);
    window.addEventListener("touchend", settle, opts);
    window.addEventListener("focusin", settle);
    window.addEventListener("focusout", settle);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pageshow", settle);
      window.removeEventListener("orientationchange", settle);
      window.removeEventListener("resize", settle);
      document.removeEventListener("visibilitychange", onVisible);
      vv?.removeEventListener("resize", settle);
      vv?.removeEventListener("scroll", measure);
      window.removeEventListener("touchstart", settle, opts);
      window.removeEventListener("touchend", settle, opts);
      window.removeEventListener("focusin", settle);
      window.removeEventListener("focusout", settle);
      probe.remove();
      root.style.removeProperty("--vp-gap");
      root.style.removeProperty("--kb-inset");
    };
  }, []);
}

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
  useViewportGap();
  const diag = useDiagEnabled(); // 明示的な診断モードでだけ true（通常は常に false）
  useProfileTheme();
  const nav = resolveNav(settings.nav);
  const all = availableNav();
  const settingsActive = pathname.startsWith("/settings");
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
    <div className="min-h-dvh md:flex">
      {/* PC: 左ナビ（利用できるすべての機能。ユーザー切替・通知・設定はヘッダー） */}
      <aside className="hidden w-52 shrink-0 flex-col gap-4 border-r bg-header p-4 md:flex">
        <BrandLogo className="px-1 pt-1" />
        <nav aria-label="メイン" className="flex flex-col gap-1">
          {all.map((n) => link(n, "flex min-h-10 items-center gap-2 rounded-md px-3 text-sm", "bg-primary text-primary-foreground", "hover:bg-muted", "size-4"))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 上部ヘッダー: アプリ名(小)・通知ベル・現在のユーザー・設定（歯車）。ステータスバー/Dynamic Island分は Safe Area で確保 */}
        <header className="sticky top-0 z-30 border-b border-t-2 border-t-primary bg-header pt-safe px-safe shadow-card">
          <div className="flex h-10 items-center justify-between px-3">
            <BrandLogo className="md:hidden" />
            <span className="hidden md:block" />
            <div className="flex items-center gap-0.5">
              <Link
                href="/settings"
                aria-label="設定"
                aria-current={settingsActive ? "page" : undefined}
                data-testid="header-settings"
                className={cn("flex size-10 items-center justify-center rounded-md hover:bg-muted", settingsActive && "text-primary")}
              >
                <Settings className="size-[18px]" aria-hidden="true" />
              </Link>
              <NotificationBell />
              <ProfileChip />
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-3 pb-[calc(3.25rem+env(safe-area-inset-bottom)+0.75rem)] pt-2 md:px-6 md:pb-8 md:pt-3">
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
        </main>
        {/* モバイル: 下部メニュー（プロフィール別・最大5枠。隠れた機能があれば「その他」）。背景は下端まで伸び、操作部分はホームインジケーターの少し上 */}
        <nav aria-label="メイン" data-testid="bottom-nav" className="fixed inset-x-0 bottom-[calc(var(--vp-gap,0px)*-1)] z-30 border-t bg-header after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-40 after:bg-header after:content-[''] pb-[max(0px,calc(env(safe-area-inset-bottom)-0.5rem))] px-safe md:hidden">
          <div className="grid h-[3.25rem]" style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }}>
            {nav.direct.map((n) => link(n, "flex flex-col items-center justify-center gap-0.5 text-[11px]", "font-bold text-primary", "text-muted-foreground", "size-5"))}
            {nav.more.length > 0 && (
              <button
                type="button"
                onClick={() => setMore(true)}
                aria-haspopup="dialog"
                data-testid="nav-more"
                className={cn("flex flex-col items-center justify-center gap-0.5 text-[11px]", nav.more.some((n) => isNavActive(n, pathname)) ? "font-bold text-primary" : "text-muted-foreground")}
              >
                <Ellipsis className="size-5" aria-hidden="true" />
                その他
              </button>
            )}
          </div>
        </nav>
        {diag && <LayoutDiagnostics />}
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

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <AiJobsProvider>
        <Shell>{children}</Shell>
      </AiJobsProvider>
    </AppProvider>
  );
}
