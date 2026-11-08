"use client";

import { useEffect, useRef } from "react";
import { inHorizontalScroller, startsAtEdge, tabSwipeDirection, type TabDirection } from "@/lib/tab-swipe";

/** 入力欄・スライダー・操作を明示的に除外した領域では、横スワイプをタブ切替に使わない */
const IGNORE = "input,select,textarea,[role='slider'],[role='tablist'],[data-no-swipe],[data-no-tab-swipe]";

/**
 * 抽選管理のタブ切替スワイプ（Stage 7B）。画面全体のタッチを監視し、縦スクロール・端からの操作（iOSの戻る）・シート/ダイアログの操作・
 * 横スクロールできる要素・入力欄・複数指の操作では動かない。タッチ端末（pointer: coarse）だけで有効。ブラウザのスクロールは妨げない（passive）。
 */
export function useTabSwipe(enabled: boolean, onSwipe: (dir: TabDirection) => void) {
  const cb = useRef(onSwipe);
  useEffect(() => {
    cb.current = onSwipe;
  });
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (typeof window.matchMedia === "function" && !window.matchMedia("(pointer: coarse)").matches) return;
    let start: { x: number; y: number; t: number } | null = null;
    const onStart = (e: TouchEvent) => {
      start = null;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const target = e.target as Element | null;
      if (!target || startsAtEdge(t.clientX, window.innerWidth)) return;
      // ボトムシート・ダイアログが開いている間、またはその中での操作は対象外
      if (document.querySelector("[role='dialog'],[role='alertdialog']") || target.closest(IGNORE) || inHorizontalScroller(target)) return;
      start = { x: t.clientX, y: t.clientY, t: Date.now() };
    };
    const onMove = (e: TouchEvent) => {
      if (start && e.touches.length > 1) start = null; // 2本指（ピンチなど）に変わったら取り消し
    };
    const onEnd = (e: TouchEvent) => {
      const s = start;
      start = null;
      if (!s) return;
      const t = e.changedTouches[0];
      const dir = tabSwipeDirection(t.clientX - s.x, t.clientY - s.y, window.innerWidth, Date.now() - s.t);
      if (dir) cb.current(dir);
    };
    const onCancel = () => {
      start = null;
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
    };
  }, [enabled]);
}
