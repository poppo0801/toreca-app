import { useEffect } from "react";
import { isEditingElement, keyboardInset, needsViewportReset } from "@/lib/viewport-insets";

/**
 * キーボードが隠している下側の高さを --kb-inset に反映する（ボトムシートの位置・最大高さの調整用）。イベント駆動のみ（常時のタイマー・ポーリングはしない）。
 *
 * 下部メニューの位置はここでは扱わない。以前は fixed の下部メニューの bottom を、測定値（--vp-gap / --vv-shift）で動かして表示領域に合わせていたが、
 * iOS のホーム画面アプリは起動直後・復帰・キーボード開閉・バウンスのたびに innerHeight / 100vh / visualViewport が互いに食い違う一時的な値を取り、
 * 測定→補正は常に動く標的を追う形で、補正が残る（下が切れる）・過剰に効く（浮く）のどちらかに必ずなった（docs/stage6j-viewport.md）。
 * 現在は画面全体を固定の入れ物にして下部メニューをその最下段に置くため、メニューの位置に測定は不要。
 *
 * キーボードを閉じたあとのずれの補正（Stage 7P）: iOS はキーボードを出すとき、入力欄を見せるためにページ（レイアウトビューポート）を押し上げる。
 * 閉じても元に戻らないことがあり、残ると描画位置とタップ判定の位置が食い違う（ページ自体は固定でスクロールできず、利用者は戻せない。再度の開閉で直る）。
 * 入力中でないのにページが 0 からずれているときだけ、ページの位置を 0 へ戻す（アプリ内のスクロール位置・入力内容・ダイアログの状態は変えない。再描画・再読み込みはしない）。
 */
export function useKeyboardInset() {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    const apply = () => {
      const px = keyboardInset(window.innerHeight, vv ?? null);
      if (px > 0) root.style.setProperty("--kb-inset", `${px}px`);
      else root.style.removeProperty("--kb-inset");
    };
    // キーボードの出入りのアニメーション中だけ、フレームごとに追従する（約0.6秒。終われば止める）
    let raf = 0;
    let until = 0;
    const tick = () => {
      apply();
      raf = performance.now() < until ? requestAnimationFrame(tick) : 0;
    };
    const follow = () => {
      until = performance.now() + 600;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    // キーボードを閉じたあとに残ったページの押し上げを元に戻す。入力欄へ移るだけ（focusout の直後に focusin）のときは、入力中なので何もしない
    const settle = () => {
      // 入力欄にフォーカスが残っていても、キーボードが実際に出ていなければ（スワイプで閉じた・外付けキーボード）入力中とは見なさない
      const editing = isEditingElement(document.activeElement) && keyboardInset(window.innerHeight, vv ?? null) > 0;
      if (needsViewportReset({ editing, scrollX: window.scrollX, scrollY: window.scrollY, vv: vv ?? null })) window.scrollTo(0, 0);
    };
    const timers = new Set<number>();
    const afterBlur = () => {
      // キーボードを閉じるアニメーション（約0.4秒）の途中と終わりで確認する。iOS の復元が遅れても取りこぼさない
      for (const ms of [150, 450, 900]) {
        const t = window.setTimeout(() => {
          timers.delete(t);
          apply();
          settle();
        }, ms);
        timers.add(t);
      }
    };
    const onViewport = () => {
      apply();
      settle();
    };
    apply();
    vv?.addEventListener("resize", follow);
    vv?.addEventListener("resize", settle);
    vv?.addEventListener("scroll", onViewport);
    window.addEventListener("focusout", afterBlur);
    window.addEventListener("focusin", follow);
    window.addEventListener("focusout", follow);
    window.addEventListener("orientationchange", follow);
    document.addEventListener("visibilitychange", follow);
    return () => {
      cancelAnimationFrame(raf);
      for (const t of timers) window.clearTimeout(t);
      window.removeEventListener("focusout", afterBlur);
      vv?.removeEventListener("resize", follow);
      vv?.removeEventListener("resize", settle);
      vv?.removeEventListener("scroll", onViewport);
      window.removeEventListener("focusin", follow);
      window.removeEventListener("focusout", follow);
      window.removeEventListener("orientationchange", follow);
      document.removeEventListener("visibilitychange", follow);
      root.style.removeProperty("--kb-inset");
    };
  }, []);
}
