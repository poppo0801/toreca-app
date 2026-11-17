"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { iconOf } from "@/components/page-heading";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { hitQuickItem, LONG_PRESS_MS, movedTooFar, type Box } from "@/lib/quick-menu";
import type { NavItem } from "@/lib/profile-settings";
import { cn } from "@/lib/utils";

/**
 * 利用できる全機能の一覧（アイコン＋機能名のグリッド）。「メニュー」画面と、設定画面の「機能一覧」で共通に使う。
 * 長押しを使わなくても、ここからすべての機能に辿れる（アクセシビリティ）。表示する機能は呼び出し側が権限で絞る。
 */
export function NavMenuGrid({ items, onNavigate, activeId }: { items: NavItem[]; onNavigate?: () => void; activeId?: string | null }) {
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="nav-grid">
      {items.map((n) => {
        const Icon = iconOf(n.id);
        const active = activeId === n.id;
        return (
          <li key={n.id}>
            <Link
              href={n.href}
              onClick={onNavigate}
              data-more={n.id}
              aria-current={active ? "page" : undefined}
              className={cn("flex min-h-[4.5rem] flex-col items-center justify-center gap-1 rounded-lg border px-1 py-2 text-center text-xs leading-tight active:bg-muted/60", active && "border-primary font-bold text-primary-ink")}
            >
              <Icon className="size-6 text-muted-foreground" aria-hidden="true" />
              <span className="line-clamp-2 break-all">{n.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** 通常のメニュー画面（ボトムシート）。「メニュー」のタップ・クリックで開く */
export function NavMenuSheet({ open, onOpenChange, items, activeId }: { open: boolean; onOpenChange: (v: boolean) => void; items: NavItem[]; activeId: string | null }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="more-sheet" aria-describedby="more-desc">
        <div className="px-4 pb-2">
          <SheetTitle>メニュー</SheetTitle>
          <SheetDescription id="more-desc" className="sr-only">
            利用できるすべての機能です。
          </SheetDescription>
        </div>
        <SheetBody className="border-t pt-3">
          <NavMenuGrid items={items} onNavigate={() => onOpenChange(false)} activeId={activeId} />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/**
 * 下部メニュー右端の「メニュー」ボタン。
 *  - 通常のタップ／クリック（キーボードのEnter・Spaceも）: 全機能の一覧（onOpenMenu）を開く
 *  - 長押し（LONG_PRESS_MS）: 画面右下から上方向にショートカットを展開。指を離さず上へドラッグ→指の位置の項目をハイライト→離すとその機能へ移動。
 *    項目の外で離す・操作が中断（pointercancel・画面の非表示・Escape）されたときはキャンセル（移動しない）
 *  - 長押し中・ドラッグ中はページをスクロールしない（touch-action: none ＋ ポインターキャプチャ）。テキスト選択・コンテキストメニューは出さない。
 * 長押しはあくまで近道。通常のメニューからすべての機能に辿れる。
 */
export function MenuButton({ quick, active, onOpenMenu, className, testId = "nav-more" }: { quick: NavItem[]; active: boolean; onOpenMenu: () => void; className?: string; testId?: string }) {
  const router = useRouter();
  const btnRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const activated = useRef(false);
  const suppressClick = useRef(false);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(-1);
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null);
  const hoverRef = useRef(-1);

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const close = useCallback(() => {
    clearTimer();
    start.current = null;
    activated.current = false;
    hoverRef.current = -1;
    setOpen(false);
    setHover(-1);
  }, []);
  // 展開中に画面が隠れた・Escapeが押された・ウィンドウが変わったときも、正常に閉じる（途中中断）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onVis = () => document.visibilityState === "hidden" && close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [open, close]);
  useEffect(() => () => clearTimer(), []);

  const boxes = (): (Box | null)[] => quick.map((_, i) => itemRefs.current[i]?.getBoundingClientRect() ?? null);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (quick.length === 0) return; // 長押しの項目が無ければ、通常のタップだけ
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    activated.current = false;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 一部の環境ではキャプチャできない（動作は続ける） */
    }
    clearTimer();
    timer.current = window.setTimeout(() => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r || !start.current) return;
      setAnchor({ right: Math.max(8, window.innerWidth - r.right), bottom: Math.max(8, window.innerHeight - r.top + 8) });
      activated.current = true;
      setOpen(true);
      try {
        navigator.vibrate?.(8);
      } catch {
        /* 非対応 */
      }
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s || e.pointerId !== s.id) return;
    if (!activated.current) {
      if (movedTooFar(s, { x: e.clientX, y: e.clientY })) {
        // 長押しの成立前に動いた: 長押しをやめる（通常の操作として扱う）
        clearTimer();
        start.current = null;
      }
      return;
    }
    e.preventDefault();
    const h = hitQuickItem({ x: e.clientX, y: e.clientY }, boxes());
    if (h !== hoverRef.current) {
      hoverRef.current = h;
      setHover(h);
    }
  };
  const finish = (e: React.PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const s = start.current;
    if (!s || e.pointerId !== s.id) return;
    const wasActive = activated.current;
    const target = hoverRef.current;
    close();
    if (!wasActive) return; // 通常のタップ。click イベントが続く
    suppressClick.current = true; // 長押し後に出る click は、メニューを開く操作として扱わない
    window.setTimeout(() => (suppressClick.current = false), 400);
    if (!cancelled && target >= 0 && quick[target]) router.push(quick[target].href);
  };

  // レイアウトが決まる前の測定を避ける（展開直後に項目の位置を取れる）
  useLayoutEffect(() => {
    if (open) itemRefs.current.length = quick.length;
  }, [open, quick.length]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid={testId}
        aria-haspopup="dialog"
        aria-label="メニュー（長押しでショートカット）"
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          onOpenMenu();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onLostPointerCapture={(e) => activated.current && finish(e as unknown as React.PointerEvent<HTMLButtonElement>, true)}
        onContextMenu={(e) => e.preventDefault()}
        className={cn("select-none touch-none [-webkit-touch-callout:none] [-webkit-user-select:none]", className, active && "font-bold text-primary-ink")}
      >
        <Menu className="size-5" aria-hidden="true" />
        メニュー
      </button>
      {open && anchor && (
        <>
          <div className="pointer-events-none fixed inset-0 z-40 bg-black/25" aria-hidden="true" data-testid="quick-backdrop" />
          <ul
            role="menu"
            aria-label="ショートカット"
            data-testid="quick-menu"
            className="pointer-events-none fixed z-50 flex flex-col gap-1.5"
            style={{ right: anchor.right, bottom: anchor.bottom }}
          >
            {quick.map((n, i) => {
              const Icon = iconOf(n.id);
              return (
                <li
                  key={n.id}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  role="menuitem"
                  data-quick={n.id}
                  data-hover={hover === i ? "true" : "false"}
                  className={cn("flex h-11 min-w-44 items-center gap-2.5 rounded-xl border bg-card px-3 text-sm shadow-lg", hover === i && "border-primary bg-primary text-primary-foreground")}
                >
                  <Icon className="size-5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{n.label}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
