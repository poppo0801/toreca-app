import { useCallback, useEffect, useRef } from "react";
import { appScroller } from "@/lib/app-scroll";

/** 入力欄がキーボードで隠れないために、アプリ内のスクロール領域を動かす量（px。0なら動かさない）。純関数 */
export function inputScrollDelta(rect: { top: number; bottom: number }, vv: { height: number; offsetTop: number; scale: number } | null, margin = 12): number {
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return 0;
  const top = vv.offsetTop + margin;
  const bottom = vv.offsetTop + vv.height - margin;
  if (rect.bottom > bottom) return Math.round(rect.bottom - bottom);
  if (rect.top < top) return Math.round(rect.top - top);
  return 0;
}

/**
 * 入力欄をタップしてキーボードが出たあと、入力欄が見える位置まで自動スクロールする（Stage 7S）。
 *  - 動かすのはアプリ内のスクロール領域（#app-scroll）だけ。画面全体の transform・window のスクロールは使わない（表示位置とタップ判定のズレを再発させない）
 *  - visualViewport の見えている領域で判定。キーボードの出現アニメーションに合わせて、フォーカス直後・約0.35秒後・viewport の resize で確認する
 *  - キーボードを閉じたときは何も動かさない（スクロール位置はそのまま。ページの押し上げの復元は use-keyboard-inset が担当）
 */
export function useScrollInputIntoView() {
  const timers = useRef<number[]>([]);
  const clear = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };
  useEffect(() => clear, []);
  return useCallback((e: { currentTarget: Element }) => {
    const el = e.currentTarget;
    clear();
    const vv = window.visualViewport ?? null;
    const run = () => {
      if (document.activeElement !== el) return;
      const d = inputScrollDelta(el.getBoundingClientRect(), vv);
      if (d === 0) return;
      const sc = appScroller();
      if (sc) sc.scrollBy({ top: d });
    };
    for (const ms of [60, 350, 700]) timers.current.push(window.setTimeout(run, ms));
    const onResize = () => run();
    vv?.addEventListener("resize", onResize, { once: true });
  }, []);
}
