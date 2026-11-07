"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { moveItem } from "@/lib/reorder";

/**
 * 長押しドラッグによる並び替え（Stage 6K）。タッチ（iPhone）を優先し、マウスでも長押しで始められる。
 *  - 長押し（既定 380ms）でドラッグ開始。それまでに指が動いたら縦スクロールとして扱い、何もしない（誤操作防止）
 *  - ドラッグ中は指に追従し、重なったカードの位置へ並びが入れ替わる（入れ替わるカードは滑らかに移動）。画面の端ではスクロール領域を自動スクロール
 *  - 離すと確定（onDrop）。ドラッグ直後のクリック（詳細表示）は抑止する

 * iPhone の長押し（Stage 6P）: 長押しの長さに上限は無い。iOS は長く押し続けると pointercancel を送って以後のポインターイベントを止めることがあるため、
 * ドラッグ中（active）の pointercancel では解除せず、touchmove / touchend / touchcancel で追従と確定を続ける。指を離す（touchend/touchcancel/pointerup）まで解除しない。
 * 並び順そのものは呼び出し側が持ち、このフックは onMove(新しい並び) を呼ぶだけ（カードの情報は変更しない）。
 *
 * 入れ替えの判定は、カードの「あるべき位置（アニメーション中の見た目の移動を除いた位置）」で行う。
 * 見た目の位置で判定すると、入れ替わった直後のカードがゆっくり移動している間も指の下に残り、すぐ元へ入れ替え直して
 * 行ったり来たりを繰り返してしまう。さらに、入れ替えた直後の相手とは、指がそのカードの上から離れるまで再び入れ替えない。
 */
export const LONG_PRESS_MS = 380;

/**
 * 並び替え後の光の演出の復旧（Stage 6P）。ドラッグ中・並び替え中は、指の下のカードが入れ替わっても pointerleave が届かず、
 * 触れた状態（data-touch=1）が残って定期的な光が止まったままになる。残りを外し、画面外判定（data-offscreen）も位置から決め直す。
 */
export function resetShineState(root: HTMLElement | null): void {
  if (!root || typeof window === "undefined") return;
  const run = () => {
    const box = document.getElementById("app-scroll")?.getBoundingClientRect();
    root.querySelectorAll<HTMLElement>(".card-shine").forEach((el) => {
      delete el.dataset.touch;
      const r = el.getBoundingClientRect();
      const vis = r.bottom > (box?.top ?? 0) && r.top < (box?.bottom ?? window.innerHeight) && r.right > 0 && r.left < window.innerWidth;
      el.dataset.offscreen = vis ? "0" : "1";
    });
  };
  run();
  // 直後に届く保留中の更新や、移動のアニメーションの終わりのあとにも確実にやり直す
  requestAnimationFrame(() => requestAnimationFrame(run));
  window.setTimeout(run, 700);
}
const MOVE_TOLERANCE_PX = 10;
const EDGE_PX = 72;

interface Session {
  id: string;
  el: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  grabDX: number;
  grabDY: number;
  tx: number;
  ty: number;
  active: boolean;
  /** 直前に入れ替えた相手。指がその上にある間は入れ替えを繰り返さない */
  lock: string | null;
  timer: number;
  raf: number;
  pointerId: number;
}

export function useDragReorder({
  enabled,
  ids,
  onMove,
  onDrop,
  scrollRootId = "app-scroll",
  longPressMs = LONG_PRESS_MS,
}: {
  enabled: boolean;
  /** 現在の表示順 */
  ids: string[];
  onMove: (ids: string[]) => void;
  /** ドラッグ確定（最終の並び） */
  onDrop: (ids: string[]) => void;
  scrollRootId?: string;
  longPressMs?: number;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const idsRef = useRef(ids);
  const cb = useRef({ onMove, onDrop });
  const session = useRef<Session | null>(null);
  const rects = useRef<Map<string, DOMRect> | null>(null);
  const container = useRef<HTMLElement | null>(null);
  const handlers = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void; cancel: (e: PointerEvent) => void; tmove: (e: TouchEvent) => void; tend: (e: TouchEvent) => void; tcancel: (e: TouchEvent) => void } | null>(null);

  useEffect(() => {
    idsRef.current = ids;
    cb.current = { onMove, onDrop };
  });

  // 並びが入れ替わったとき、動いたカードが元の位置から滑らかに移動する（FLIP）
  const key = ids.join("|");
  useLayoutEffect(() => {
    const first = rects.current;
    rects.current = null;
    const root = container.current;
    if (!first || !root) return;
    for (const el of root.querySelectorAll<HTMLElement>("[data-drag-id]")) {
      const id = el.dataset.dragId as string;
      if (id === session.current?.id) continue;
      const a = first.get(id);
      if (!a) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform 620ms cubic-bezier(0.22, 0.7, 0.25, 1)";
        el.style.transform = "";
      });
    }
  }, [key]);

  // 並び替え中に画面が縦スクロールしないよう、タッチの移動を止める（開始前のスクロールは妨げない）
  useEffect(() => {
    if (!enabled) return;
    const block = (e: TouchEvent) => {
      if (session.current?.active && e.cancelable) e.preventDefault();
    };
    window.addEventListener("touchmove", block, { passive: false });
    return () => window.removeEventListener("touchmove", block);
  }, [enabled]);

  const place = (s: Session) => {
    const r = s.el.getBoundingClientRect();
    const baseLeft = r.left - s.tx;
    const baseTop = r.top - s.ty;
    s.tx = s.x - s.grabDX - baseLeft;
    s.ty = s.y - s.grabDY - baseTop;
    s.el.style.transform = `translate(${s.tx}px, ${s.ty}px) scale(1.04)`;
  };

  /** カードのあるべき位置（移動のアニメーション中の translate を除く） */
  const layoutRect = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    const t = typeof getComputedStyle === "function" ? getComputedStyle(el).transform : "";
    if (t && t !== "none" && typeof DOMMatrix !== "undefined") {
      try {
        const m = new DOMMatrix(t);
        dx = m.m41;
        dy = m.m42;
      } catch {
        /* 読めなければ見た目の位置のまま */
      }
    }
    return { left: r.left - dx, right: r.right - dx, top: r.top - dy, bottom: r.bottom - dy };
  };

  const hit = (s: Session): string | null => {
    const root = container.current;
    if (!root) return null;
    for (const el of root.querySelectorAll<HTMLElement>("[data-drag-id]")) {
      const id = el.dataset.dragId as string;
      if (id === s.id) continue;
      const r = layoutRect(el);
      if (s.x >= r.left && s.x <= r.right && s.y >= r.top && s.y <= r.bottom) return id;
    }
    return null;
  };

  const step = (s: Session) => {
    if (session.current !== s || !s.active) return;
    // 画面の端に近いときは、スクロール領域を自動で動かす
    const root = document.getElementById(scrollRootId);
    if (root) {
      const b = root.getBoundingClientRect();
      const dy = s.y < b.top + EDGE_PX ? -Math.ceil((b.top + EDGE_PX - s.y) / 12) : s.y > b.bottom - EDGE_PX ? Math.ceil((s.y - (b.bottom - EDGE_PX)) / 12) : 0;
      if (dy !== 0) root.scrollTop += dy;
    }
    place(s);
    s.raf = requestAnimationFrame(() => step(s));
  };

  const finish = (commit: boolean) => {
    const s = session.current;
    if (!s) return;
    window.clearTimeout(s.timer);
    cancelAnimationFrame(s.raf);
    const h = handlers.current;
    if (h) {
      window.removeEventListener("pointermove", h.move);
      window.removeEventListener("pointerup", h.up);
      window.removeEventListener("pointercancel", h.cancel);
      window.removeEventListener("touchmove", h.tmove);
      window.removeEventListener("touchend", h.tend);
      window.removeEventListener("touchcancel", h.tcancel);
    }
    const wasActive = s.active;
    const el = s.el;
    el.removeAttribute("data-dragging");
    if (wasActive) {
      // 離した位置から、移動先の枠へカードがそのまま滑って収まる（瞬時に飛ばない）。終わったら後始末
      el.style.transition = "transform 420ms cubic-bezier(0.22, 0.7, 0.25, 1)";
      el.style.transform = "";
      window.setTimeout(() => {
        if (el.getAttribute("data-dragging")) return; // すぐ次のドラッグが始まっていたら触らない
        el.style.transition = "";
        el.style.zIndex = "";
        el.style.willChange = "";
      }, 460);
    } else {
      el.style.transform = "";
      el.style.transition = "";
      el.style.zIndex = "";
      el.style.willChange = "";
    }
    session.current = null;
    setDragId(null);
    // 並び替えのあと、光の演出が止まったままのカードが出ないよう、触れた状態の残りを外して画面内判定をやり直す
    resetShineState(container.current);
    if (wasActive) {
      // ドラッグ直後に出る click（詳細を開く）を一度だけ止める
      const stop = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener("click", stop, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
      if (commit) cb.current.onDrop(idsRef.current);
    }
  };

  const onMoveEvent = (e: PointerEvent) => {
    const s = session.current;
    if (!s || e.pointerId !== s.pointerId) return;
    moveTo(s, e.clientX, e.clientY);
  };
  const moveTo = (s: Session, x: number, y: number) => {
    s.x = x;
    s.y = y;
    if (!s.active) {
      if (Math.hypot(s.x - s.startX, s.y - s.startY) > MOVE_TOLERANCE_PX) finish(false); // 長押しの前に動いた = スクロール
      return;
    }
    const over = hit(s);
    if (over !== s.lock) s.lock = null; // 指が相手の上から離れたら、また入れ替えられる
    if (!over || over === s.lock) return;
    const cur = idsRef.current;
    const next = moveItem(cur, s.id, cur.indexOf(over));
    if (next.join("|") === cur.join("|")) return;
    const m = new Map<string, DOMRect>();
    container.current?.querySelectorAll<HTMLElement>("[data-drag-id]").forEach((el) => m.set(el.dataset.dragId as string, el.getBoundingClientRect()));
    rects.current = m;
    s.lock = over;
    idsRef.current = next;
    cb.current.onMove(next);
  };

  const bind = (id: string) => ({
    "data-drag-id": id,
    onContextMenu: enabled ? (e: React.MouseEvent) => e.preventDefault() : undefined,
    onPointerDown: enabled
      ? (e: React.PointerEvent<HTMLElement>) => {
          if (session.current || (e.pointerType === "mouse" && e.button !== 0)) return;
          const el = e.currentTarget;
          container.current = el.parentElement;
          const r = el.getBoundingClientRect();
          const s: Session = { id, el, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, grabDX: e.clientX - r.left, grabDY: e.clientY - r.top, tx: 0, ty: 0, active: false, lock: null, timer: 0, raf: 0, pointerId: e.pointerId };
          session.current = s;
          const touch = e.pointerType === "touch";
          handlers.current = {
            move: onMoveEvent,
            up: (ev) => session.current && ev.pointerId === session.current.pointerId && finish(true),
            // iOS が長押しの途中で pointercancel を送っても、ドラッグ中なら解除しない（指を離すまで続ける。touchend/touchcancel で確定）
            cancel: (ev) => {
              const cur = session.current;
              if (!cur || ev.pointerId !== cur.pointerId) return;
              if (cur.active && touch) return;
              finish(false);
            },
            tmove: (ev) => {
              const cur = session.current;
              if (!cur || ev.touches.length !== 1) return;
              moveTo(cur, ev.touches[0].clientX, ev.touches[0].clientY);
            },
            tend: () => {
              const cur = session.current;
              if (cur) finish(cur.active);
            },
            tcancel: () => {
              const cur = session.current;
              if (cur) finish(cur.active);
            },
          };
          window.addEventListener("pointermove", handlers.current.move);
          window.addEventListener("pointerup", handlers.current.up);
          window.addEventListener("pointercancel", handlers.current.cancel);
          if (touch) {
            window.addEventListener("touchmove", handlers.current.tmove, { passive: true });
            window.addEventListener("touchend", handlers.current.tend);
            window.addEventListener("touchcancel", handlers.current.tcancel);
          }
          s.timer = window.setTimeout(() => {
            if (session.current !== s) return;
            s.active = true;
            el.setAttribute("data-dragging", "1");
            el.style.zIndex = "30";
            el.style.willChange = "transform";
            el.style.transition = "none";
            navigator.vibrate?.(12);
            setDragId(id);
            place(s);
            s.raf = requestAnimationFrame(() => step(s));
          }, longPressMs);
        }
      : undefined,
  });

  // アンマウント時は後始末だけ（確定しない）
  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      window.clearTimeout(s.timer);
      cancelAnimationFrame(s.raf);
      const h = handlers.current;
      if (h) {
        window.removeEventListener("pointermove", h.move);
        window.removeEventListener("pointerup", h.up);
        window.removeEventListener("pointercancel", h.cancel);
        window.removeEventListener("touchmove", h.tmove);
        window.removeEventListener("touchend", h.tend);
        window.removeEventListener("touchcancel", h.tcancel);
      }
      session.current = null;
    },
    [],
  );

  return { bind, dragId };
}
