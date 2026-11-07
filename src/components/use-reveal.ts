"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * カードの順次フェード表示（Stage 6R）。画像の通信とは無関係に、表示の演出だけを順序制御する。
 *  - 枠（プレースホルダー）は先に出ており、画面に入ったカードを「左上→右、行ごと」の順に、一定の間隔でずらしてフェードインさせる
 *  - 一度表示したカード（id）は記録し、再スクロール・詳細の開閉・ドラッグ並び替え・並び順の変更・一覧の作り直しでは再演出しない
 *  - 画面外のカードは、表示範囲に入った時点で演出する。画像が遅くても後続カードの演出を妨げない（演出は画像の読み込みを待たない）
 *  - 演出は opacity だけ（transform は触らない）。光のエフェクト（ホログラム）・ドラッグの移動と干渉しない
 *  - 動きを減らす設定・IntersectionObserver が無い環境では、演出なしで即表示
 * 状態は DOM の data-reveal 属性（未設定=透明 / in=演出中 / done=表示済み）に持ち、Reactの再描画で巻き戻らない。
 */
const TOTAL_MS = 1200;
const MAX_STEP = 70;
const MIN_STEP = 12;

export function useReveal(enabled: boolean) {
  const seen = useRef<Set<string>>(new Set());
  const items = useRef<Map<Element, string>>(new Map());
  const pending = useRef<{ id: string; el: HTMLElement }[]>([]);
  const raf = useRef(0);
  const io = useRef<IntersectionObserver | null>(null);

  const reduced = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const flush = useCallback(() => {
    raf.current = 0;
    const list = pending.current.splice(0);
    if (list.length === 0) return;
    // 左上から右へ、行ごと（同じ行は左から）。行の高さの半分以内の差は同じ行とみなす
    const rects = list.map((x) => ({ ...x, r: x.el.getBoundingClientRect() }));
    rects.sort((a, b) => {
      const rowGap = Math.min(a.r.height, b.r.height) / 2;
      return Math.abs(a.r.top - b.r.top) > rowGap ? a.r.top - b.r.top : a.r.left - b.r.left;
    });
    const step = rects.length <= 1 ? 0 : Math.max(MIN_STEP, Math.min(MAX_STEP, Math.floor(TOTAL_MS / rects.length)));
    rects.forEach(({ id, el }, i) => {
      seen.current.add(id);
      el.style.setProperty("--d", `${i * step}ms`);
      el.setAttribute("data-reveal", "in");
    });
  }, []);

  useEffect(() => {
    const el = io;
    return () => {
      el.current?.disconnect();
      el.current = null;
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, []);

  /** 一覧の各カード(li)に付ける ref。id ごとに呼ばれる */
  const bind = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (!el) return;
      // 表示済み・演出しない設定・非対応環境: すぐ表示（透明にしない）
      if (!enabled || seen.current.has(id) || reduced() || typeof IntersectionObserver === "undefined") {
        // 演出中(in)のカードを、再描画で途中から止めない
        if (!el.getAttribute("data-reveal")) el.setAttribute("data-reveal", "done");
        return;
      }
      if (el.getAttribute("data-reveal")) return;
      io.current ??= new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const target = en.target as HTMLElement;
          const rid = items.current.get(target);
          io.current?.unobserve(target);
          items.current.delete(target);
          if (!rid || seen.current.has(rid) || target.getAttribute("data-reveal")) continue;
          pending.current.push({ id: rid, el: target });
        }
        if (pending.current.length > 0 && !raf.current) {
          raf.current = -1;
          const id = requestAnimationFrame(flush);
          if (raf.current === -1) raf.current = id;
        }
      });
      items.current.set(el, id);
      io.current.observe(el);
      return () => {
        io.current?.unobserve(el);
        items.current.delete(el);
      };
    },
    [enabled, flush],
  );

  return { bind, seen };
}
