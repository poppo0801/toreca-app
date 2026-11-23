"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpDown, Check } from "lucide-react";
import { MARKET_SORT_LABEL, MARKET_SORT_MENU, nextMarketSort, type MarketSort } from "@/lib/zukan/zukan";
import { cn } from "@/lib/utils";

/** 長押しとみなす時間（ミリ秒）。通常のタップとの誤操作を避けるため、移動が大きいときは長押しにしない */
export const SORT_LONG_PRESS_MS = 420;
const MOVE_CANCEL_PX = 10;

/**
 * 並び替えボタン（アイコンのみ）。
 *  - 通常タップ: 新着順 → 価格降順 → 価格昇順 → 状態順 → レアリティ順 → 五十音順 → 新着順
 *  - 長押し（またはコンテキストメニュー）: 全ての並び替え項目を一覧にし、直接選べる。選ぶと閉じる。外側のタップ・Escでも閉じる（選ばなければ並びは変わらない）
 *  - 現在の並び順は、画面見出しの右（「新着順 ↓」など）と、aria-label・data-sort で確認できる
 */
export function MarketSortButton({ sort, onChange, className }: { sort: MarketSort; onChange: (m: MarketSort) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const long = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  return (
    <div className={cn("relative shrink-0", className)}>
      <button
        type="button"
        className="flex h-11 w-12 items-center justify-center rounded-md border bg-card text-foreground active:bg-muted"
        aria-label={`並び順: ${MARKET_SORT_LABEL[sort]}（タップで次の並び順、長押しで一覧から選ぶ）`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="market-sort"
        data-sort={sort}
        style={{ touchAction: "manipulation", WebkitTouchCallout: "none", userSelect: "none" }}
        onPointerDown={(e) => {
          long.current = false;
          start.current = { x: e.clientX, y: e.clientY };
          clear();
          timer.current = setTimeout(() => {
            long.current = true;
            setOpen(true);
          }, SORT_LONG_PRESS_MS);
        }}
        onPointerMove={(e) => {
          const s0 = start.current;
          if (s0 && Math.hypot(e.clientX - s0.x, e.clientY - s0.y) > MOVE_CANCEL_PX) clear();
        }}
        onPointerUp={clear}
        onPointerCancel={clear}
        onPointerLeave={clear}
        onContextMenu={(e) => {
          e.preventDefault();
          clear();
          long.current = true;
          setOpen(true);
        }}
        onClick={() => {
          // 長押しで一覧を開いた直後の click は、次の並び順への切り替えとして扱わない
          if (long.current) {
            long.current = false;
            return;
          }
          onChange(nextMarketSort(sort));
        }}
      >
        <ArrowUpDown className="size-5" aria-hidden="true" />
      </button>
      {open && (
        <>
          <button type="button" aria-label="並び替えの一覧を閉じる" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} data-testid="market-sort-backdrop" />
          <div role="menu" aria-label="並び替え" className="absolute right-0 top-11 z-50 w-44 rounded-lg border bg-card p-1 shadow-lg" data-testid="market-sort-menu">
            {MARKET_SORT_MENU.map((m) => (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={sort === m}
                className={cn("flex min-h-10 w-full items-center justify-between rounded-md px-2.5 text-left text-sm", sort === m ? "font-bold text-primary-ink" : "")}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
                data-testid="market-sort-option"
                data-sort={m}
              >
                {MARKET_SORT_LABEL[m]}
                {sort === m && <Check className="size-4" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
