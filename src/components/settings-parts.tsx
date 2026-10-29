"use client";

import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 設定画面の部品。設定は「見出しだけの一覧」にし、小さな項目はアコーディオンで開き、大きな項目は別ページへ移る。
 * 開閉・ページ移動のアニメーションは短いCSSのみ（動きを減らす設定ではほぼ無効になる。globals.css）。
 */
export function SubPageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-3">
      <p className="mb-1 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <h1 className="text-lg font-bold">{title}</h1>
      {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
    </header>
  );
}

const ROW = "flex min-h-14 w-full items-center gap-3 px-3 text-left";

/** 別ページへ移る項目 */
export function MenuLink({ href, title, summary, testId }: { href: string; title: string; summary?: string; testId?: string }) {
  return (
    <Link href={href} data-testid={testId} className={cn(ROW, "active:bg-muted/60")}>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        {summary && <span className="block truncate text-xs text-muted-foreground">{summary}</span>}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}

/** その場で開く項目（高さがなめらかに広がる）。閉じているときは中身を描画しない */
export function Accordion({ title, summary, children, testId, defaultOpen = false }: { title: string; summary?: string; children: React.ReactNode; testId?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // 一度開いたら中身を残す（閉じるアニメーション中に消えない）。開くまでは描画せず、データの取得も始めない
  const [seen, setSeen] = useState(defaultOpen);
  const id = useId();
  return (
    <div data-testid={testId}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => {
          setSeen(true);
          setOpen((v) => !v);
        }} className={cn(ROW, "active:bg-muted/60")}>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          {summary && <span className="block truncate text-xs text-muted-foreground">{summary}</span>}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")} aria-hidden="true" />
      </button>
      {/* grid-rows の 0fr → 1fr で高さを滑らかに変える（高さの計測が不要で、再描画も軽い） */}
      <div id={id} className={cn("grid transition-[grid-template-rows] duration-200 ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0 overflow-hidden">
          <div className={cn("border-t px-3 py-3 transition-opacity duration-200", open ? "opacity-100" : "opacity-0")} inert={!open || undefined}>
            {seen && children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MenuGroup({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <section>
      {label && <h2 className="mb-1 px-1 text-xs font-medium text-muted-foreground">{label}</h2>}
      <div className="divide-y overflow-hidden rounded-xl border bg-card">{children}</div>
    </section>
  );
}
