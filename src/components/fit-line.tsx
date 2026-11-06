"use client";

import { useCallback, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** これより小さくはしない（読めなくなる前に、はみ出さないことを優先する最小の文字サイズ） */
export const FIT_MIN_PX = 9;

/**
 * 日付行を必ず1行に収める。折り返さず、収まらないときは次の順で詰める（Stage 5Z）。
 *   1) 余白（gap）と字間を詰める  2) 行全体の文字サイズを同じ比率で縮小（一部だけ小さくしない）
 * 利用できる幅は親の幅（outer）で、アイコンも含めた1行（inner）が収まるかを実測する。
 * 返す関数は純粋な計算（テスト用）: 必要幅・利用幅・現在の文字サイズから、縮小後の文字サイズを返す。
 */
export function fitFontSize(needed: number, available: number, basePx: number, minPx = FIT_MIN_PX): number {
  if (needed <= available || available <= 0) return basePx;
  return Math.max(minPx, Math.floor(basePx * (available / needed) * 10) / 10);
}

export function FitLine({ children, className, innerProps, wrap = false, ...rest }: { children: ReactNode; className?: string; /** true のときは縮小せず、収まらない項目を次の行へ折り返す（項目の途中では折り返さない） */ wrap?: boolean; innerProps?: HTMLAttributes<HTMLSpanElement> & { "data-testid"?: string; "data-kind"?: string } } & Omit<HTMLAttributes<HTMLSpanElement>, "children" | "className">) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);

  const measure = useCallback(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    if (wrap) return;
    i.style.fontSize = "";
    i.dataset.tight = "0";
    const avail = o.clientWidth;
    if (avail <= 0 || i.scrollWidth <= avail) return;
    i.dataset.tight = "1";
    if (i.scrollWidth <= avail) return;
    const base = parseFloat(getComputedStyle(i).fontSize) || 12;
    i.style.fontSize = `${fitFontSize(i.scrollWidth, avail, base)}px`;
  }, [wrap]);
  // 描画のたびに実測し、親の幅が変わったとき（回転・分割表示・フォント読み込み）にも測り直す
  useLayoutEffect(() => measure());
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined" || !outer.current) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(outer.current);
    return () => ro.disconnect();
  }, [measure]);

  const { className: innerClass, ...innerRest } = innerProps ?? {};
  return (
    <span ref={outer} className={cn("block w-full min-w-0 max-w-full", className)} {...rest}>
      <span ref={inner} data-tight="0" className={cn(wrap ? "flex flex-wrap items-center gap-1" : "inline-flex items-center gap-1 whitespace-nowrap data-[tight=1]:gap-0.5 data-[tight=1]:tracking-tighter", innerClass)} {...innerRest}>
        {children}
      </span>
    </span>
  );
}
