import { appScroller } from "@/lib/app-scroll";
import { inputScrollDelta } from "@/lib/use-scroll-input-into-view";

/**
 * 入力欄をタップしてキーボードが出たとき、入力欄が見える位置まで自動スクロールする共通処理（Stage 8U-1）。アプリ全体の画面・ダイアログ・ボトムシートに効く。
 *  - 対象はテキスト入力（input の文字・数値・日付など、textarea）。ボタン・チェックボックス・選択（select）・読み取り専用には何もしない。画面を開いたときの自動フォーカスはしない（フォーカスされたときだけ反応）。
 *  - 動かすのは、その入力欄を含む最も近いスクロール領域（ボトムシートの本文・ダイアログ・アプリ本体 #app-scroll）だけ。画面全体の transform・window のスクロールは使わない
 *    （表示位置とタップ判定のズレを再発させない。docs/stage7p.md）。
 *  - 見えている領域 = visualViewport（キーボードを除く）とスクロール領域の枠の重なり。すでに見えている入力欄は動かさない（不要なスクロールをしない）。
 *  - 拡大は viewport の maximum-scale=1 で抑えている（拡大中は動かさない）。キーボードを閉じたときは何も動かさない。
 *  - data-no-input-reveal を付けた要素の中は対象外。
 */
const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "time", "month", "week", ""]);

export function isTextEntry(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.closest("[data-no-input-reveal]")) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type.toLowerCase()) && !el.readOnly && !el.disabled;
  return el.isContentEditable === true;
}

/** 入力欄を含む最も近いスクロール領域。縦に実際にあふれていて、overflow-y が auto / scroll のもの。無ければアプリ本体のスクロール領域 */
export function scrollParentOf(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll" || oy === "overlay") && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return appScroller();
}

/** 動かす量（px）。見える領域 = visualViewport ∩ スクロール領域の枠。0なら動かさない。純関数 */
export function revealDelta(
  rect: { top: number; bottom: number },
  vv: { height: number; offsetTop: number; scale: number } | null,
  parentRect: { top: number; bottom: number } | null,
  margin = 12,
): number {
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return 0;
  const top = Math.max(vv.offsetTop, parentRect?.top ?? -Infinity);
  const bottom = Math.min(vv.offsetTop + vv.height, parentRect?.bottom ?? Infinity);
  // 見える領域が小さすぎる（入力欄が入りきらない）ときは、上端を合わせる
  if (bottom - top < rect.bottom - rect.top + margin * 2) return Math.round(rect.top - top - margin);
  return inputScrollDelta(rect, { height: bottom - top, offsetTop: top, scale: 1 }, margin);
}

/** document の focusin を監視して、入力欄が隠れていれば見える位置までスクロールする。解除関数を返す（テストでは doc・win・時刻の遅延を差し替えられる） */
export function installInputReveal(doc: Document = document, win: Window = window, delays: number[] = [60, 350, 700]): () => void {
  const timers: number[] = [];
  let vvCleanup: (() => void) | null = null;
  const clear = () => {
    for (const t of timers.splice(0)) win.clearTimeout(t);
    vvCleanup?.();
    vvCleanup = null;
  };
  const onFocusIn = (e: FocusEvent) => {
    const el = e.target as Element | null;
    if (!isTextEntry(el)) return;
    clear();
    const vv = win.visualViewport ?? null;
    const run = () => {
      // 別の入力欄・要素へ移っていたら何もしない（古い入力欄の分で動かさない）
      if (doc.activeElement !== el) return;
      const parent = scrollParentOf(el);
      const parentRect = parent && parent !== doc.getElementById("app-scroll") ? parent.getBoundingClientRect() : null;
      const d = revealDelta(el.getBoundingClientRect(), vv, parentRect);
      if (d === 0) return;
      (parent ?? appScroller())?.scrollBy({ top: d });
    };
    for (const ms of delays) timers.push(win.setTimeout(run, ms));
    if (vv) {
      const onResize = () => run();
      vv.addEventListener("resize", onResize, { once: true });
      vvCleanup = () => vv.removeEventListener("resize", onResize);
    }
  };
  doc.addEventListener("focusin", onFocusIn);
  return () => {
    doc.removeEventListener("focusin", onFocusIn);
    clear();
  };
}
