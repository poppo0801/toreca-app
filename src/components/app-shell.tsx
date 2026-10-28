"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings, Ticket, Wallet } from "lucide-react";
import { AppProvider, useApp } from "@/components/app-provider";
import { BrandLogo } from "@/components/brand-logo";
import { NotificationBell } from "@/components/notification-bell";
import { ProfileChip } from "@/components/profile-switcher";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/lotteries", label: "抽選管理", icon: Ticket },
  { href: "/finance", label: "収支", icon: Wallet },
  { href: "/settings", label: "設定", icon: Settings },
] as const;

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { profile, notice, dismissNotice } = useApp();
  // 収支の関連ページ(/records の応募実績)は「収支」ではなく抽選側の分析なので、現在地は最も近い項目に寄せる
  const isActive = (href: string) => pathname.startsWith(href) || (href === "/finance" && pathname.startsWith("/records"));
  return (
    <div className="min-h-dvh md:flex">
      {/* PC: 左ナビ（ユーザー切替・通知はヘッダーに集約） */}
      <aside className="hidden w-52 shrink-0 flex-col gap-4 border-r bg-header p-4 md:flex">
        <BrandLogo className="px-1 pt-1" />
        <nav aria-label="メイン" className="flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-10 items-center gap-2 rounded-md px-3 text-sm",
                  active ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 上部ヘッダー: アプリ名(小)・通知ベル・現在のユーザーのみ。ノッチ/ステータスバー分は Safe Area で確保 */}
        <header className="sticky top-0 z-30 border-b border-t-2 border-t-primary bg-header pt-safe px-safe shadow-card">
          <div className="flex h-10 items-center justify-between px-3">
            <BrandLogo className="md:hidden" />
            <span className="hidden md:block" />
            <div className="flex items-center gap-0.5">
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
        {/* モバイル: 下部メイン3項目。操作部分はホームインジケーターの上に収め、背景だけが下端まで伸びる */}
        <nav
          aria-label="メイン"
          className="fixed inset-x-0 bottom-0 z-30 border-t bg-header pb-safe px-safe md:hidden"
        >
          <div className="grid h-[3.25rem] grid-cols-3">
            {NAV.map(({ href, label, icon: Icon }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex flex-col items-center justify-center gap-0.5 text-[11px]",
                    active ? "font-bold text-primary" : "text-muted-foreground",
                  )}
                >
                  <Icon className="size-5" aria-hidden="true" />
                  {label}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <Shell>{children}</Shell>
    </AppProvider>
  );
}
