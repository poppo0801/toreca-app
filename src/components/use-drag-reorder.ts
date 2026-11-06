"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { moveItem } from "@/lib/reorder";

/**
 * 長押しドラッグによる並び替え（Stage 6K）。タッチ（iPhone）を優先し、マウスでも長押しで始められる。
 *  - 長押し（既定 380ms）でドラッグ開始。それまでに指が動いたら縦スクロールとして扱い、何もしない（誤操作防止）
 *  - ドラッグ中は指に追従し、重なったカードの位置へ並びが入れ替わる（入れ替わるカードは滑らかに移動）。画面の端ではスクロール領域を自動スクロール
 *  - 離すと確定（onDrop）。ドラッグ直後のクリック（詳細表示）は抑止する
 * 並び順そのものは呼び出し側が持ち、このフックは onMove(新しい並び) を呼ぶだけ（カードの情報は変更しない）。
 */
export const LONG_PRESS_MS = 380;
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
  const handlers = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void; cancel: (e: PointerEvent) => void } | null>(null);

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

  const hit = (s: Session): string | null => {
    for (const e of document.elementsFromPoint(s.x, s.y)) {
      const t = (e as HTMLElement).closest?.("[data-drag-id]") as HTMLElement | null;
      if (t && t.dataset.dragId !== s.id) return t.dataset.dragId as string;
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
    }
    const wasActive = s.active;
    s.el.style.transform = "";
    s.el.style.transition = "";
    s.el.style.zIndex = "";
    s.el.style.willChange = "";
    s.el.removeAttribute("data-dragging");
    session.current = null;
    setDragId(null);
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
    s.x = e.clientX;
    s.y = e.clientY;
    if (!s.active) {
      if (Math.hypot(s.x - s.startX, s.y - s.startY) > MOVE_TOLERANCE_PX) finish(false); // 長押しの前に動いた = スクロール
      return;
    }
    const over = hit(s);
    if (!over) return;
    const cur = idsRef.current;
    const next = moveItem(cur, s.id, cur.indexOf(over));
    if (next.join("|") === cur.join("|")) return;
    const m = new Map<string, DOMRect>();
    container.current?.querySelectorAll<HTMLElement>("[data-drag-id]").forEach((el) => m.set(el.dataset.dragId as string, el.getBoundingClientRect()));
    rects.current = m;
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
          const s: Session = { id, el, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, grabDX: e.clientX - r.left, grabDY: e.clientY - r.top, tx: 0, ty: 0, active: false, timer: 0, raf: 0, pointerId: e.pointerId };
          session.current = s;
          handlers.current = {
            move: onMoveEvent,
            up: (ev) => session.current && ev.pointerId === session.current.pointerId && finish(true),
            cancel: (ev) => session.current && ev.pointerId === session.current.pointerId && finish(false),
          };
          window.addEventListener("pointermove", handlers.current.move);
          window.addEventListener("pointerup", handlers.current.up);
          window.addEventListener("pointercancel", handlers.current.cancel);
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
      }
      session.current = null;
    },
    [],
  );

  return { bind, dragId };
}
