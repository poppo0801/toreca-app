"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Settings, Ticket } from "lucide-react";
import { AppProvider, useApp } from "@/components/app-provider";
import { ProfileSwitcher } from "@/components/profile-switcher";
import { cn } from "@/lib/utils";
import type { Profile } from "@/types/domain";

const NAV = [
  { href: "/lotteries", label: "抽選管理", icon: Ticket },
  { href: "/records", label: "記録・分析", icon: BarChart3 },
  { href: "/settings", label: "設定", icon: Settings },
] as const;

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { profile } = useApp();
  return (
    <div className="min-h-dvh md:flex">
      {/* PC: 左ナビ */}
      <aside className="hidden w-56 shrink-0 flex-col gap-6 border-r p-4 md:flex">
        <div className="text-base font-bold">トレカ抽選管理</div>
        <nav aria-label="メイン" className="flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-md px-3 text-sm",
                  active ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto">
          <p className="mb-1 text-xs text-muted-foreground">操作プロフィール</p>
          <ProfileSwitcher />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* モバイル: 上部に現在の操作対象を常時表示 */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/95 px-4 py-1 backdrop-blur md:hidden">
          <span className="text-sm font-bold">トレカ抽選管理</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">操作中</span>
            <ProfileSwitcher />
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-3 pb-24 pt-3 md:px-6 md:pb-8">
          <p className="sr-only" aria-live="polite">
            現在の操作プロフィール: {profile.label}
          </p>
          {children}
        </main>
        {/* モバイル: 下部メイン3項目 */}
        <nav
          aria-label="メイン"
          className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t bg-background md:hidden"
        >
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs",
                  active ? "font-bold text-primary" : "text-muted-foreground",
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

export function AppShell({
  children,
  profiles,
}: {
  children: React.ReactNode;
  profiles?: Profile[];
}) {
  return (
    <AppProvider profiles={profiles}>
      <Shell>{children}</Shell>
    </AppProvider>
  );
}

