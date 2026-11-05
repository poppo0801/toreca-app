"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { classifyAxis, commitDirection, pullOffset, type SwipeDirection } from "@/lib/swipe";
import { cn } from "@/lib/utils";

/**
 * 一覧の行を左右にスワイプして操作する枠（自動収集の「要手動確認」「収集候補」用）。
 *  右スワイプ = onRight（編集フォームを開く）／左スワイプ = onLeft（その候補を除外）。
 *  ・縦スクロールとの誤判定を防ぐ: 縦スクロールが主なので、移動量が小さい間は未確定にし、横が縦の1.8倍以上のときだけ横と判定する（lib/swipe.ts。抽選カードと同じ規則）。
 *  ・一定距離を超えて指を離したときだけ確定する。足りなければ元に戻る。確定は指を離したとき（離すまで状態は変えない）。
 *  ・左スワイプ（除外）は行が左へ流れて消え、すぐに一覧から外れる。確認ダイアログは出さない。通信の結果は呼び出し側が扱い、失敗したら行を戻す。
 *  ・右スワイプ（編集）は行を元の位置に戻してフォームを開く。
 *  ・タッチ操作のみ（マウスでは動かさない。PCでは行内のボタンを使う）。長い待機時間は設けない（連続して操作できる）。
 */

/** アニメーションの長さ(ms)。連続操作を妨げないよう短くする */
export const SWIPE_ROW_EXIT_MS = 140;

interface Props {
  children: React.ReactNode;
  onRight?: () => void;
  /** 左スワイプで確定したとき、行が流れ終わってから呼ぶ。以後の削除（非表示）は呼び出し側 */
  onLeft?: () => void;
  rightLabel?: string;
  leftLabel?: string;
  disabled?: boolean;
  className?: string;
}

const SwipeEnabledContext = createContext<boolean | null>(null);
/** テスト用: タッチ判定を上書きする */
export const SwipeEnabledProvider = SwipeEnabledContext.Provider;

function useTouchEnabled(): boolean {
  const forced = useContext(SwipeEnabledContext);
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 端末の入力方式の判定（マウント後に1回）
    setTouch(typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);
  }, []);
  return forced ?? touch;
}

export function SwipeRow({ children, onRight, onLeft, rightLabel = "編集", leftLabel = "除外", disabled = false, className }: Props) {
  const enabled = useTouchEnabled() && !disabled && (!!onRight || !!onLeft);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  /** 行の幅（スワイプ開始時に測る。流れ出る距離に使う） */
  const [width, setWidth] = useState(360);
  const root = useRef<HTMLDivElement>(null);
  const g = useRef<{ id: number; x: number; y: number; axis: "pending" | "horizontal" | "vertical" } | null>(null);
  const swallowClick = useRef(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

  const down = (e: React.PointerEvent) => {
    if (!enabled || leaving || e.pointerType === "mouse" || !e.isPrimary) return;
    if ((e.target as HTMLElement).closest("input,select,textarea,[data-no-swipe]")) return;
    g.current = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: "pending" };
    setWidth(root.current?.offsetWidth || 360);
  };
  const move = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s || s.id !== e.pointerId || s.axis === "vertical") return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (s.axis === "pending") {
      const axis = classifyAxis(dx, dy);
      if (axis === "pending") return;
      s.axis = axis;
      if (axis === "vertical") return; // 縦スクロール: 以後このジェスチャは無視
      try {
        root.current?.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      setDragging(true);
    }
    const allowed = dx > 0 ? onRight : onLeft;
    setOffset(allowed ? pullOffset(dx) : pullOffset(dx) * 0.2);
  };
  const finish = (e: React.PointerEvent, cancelled: boolean) => {
    const s = g.current;
    if (!s || s.id !== e.pointerId) return;
    g.current = null;
    if (s.axis !== "horizontal") return;
    swallowClick.current = true;
    window.setTimeout(() => (swallowClick.current = false), 350);
    const dir: SwipeDirection | null = cancelled ? null : commitDirection(e.clientX - s.x, root.current?.offsetWidth || 360);
    setDragging(false);
    if (dir === "left" && onLeft) {
      // 指を離した位置から左へ流れて消え、流れ終わったら除外を呼ぶ（呼び出し側が即座に一覧から外す）
      setLeaving(true);
      timer.current = window.setTimeout(() => onLeft(), SWIPE_ROW_EXIT_MS);
      return;
    }
    setOffset(0);
    if (dir === "right" && onRight) onRight();
  };

  const w = width;
  const x = leaving ? -w : offset;
  return (
    <div
      ref={root}
      data-testid="swipe-row"
      data-swipe={enabled ? "on" : "off"}
      className={cn("relative overflow-hidden", className)}
      style={enabled ? { touchAction: "pan-y" } : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onClickCapture={(e) => {
        if (swallowClick.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {enabled && (
        <>
          {onRight && (
            <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 flex items-center bg-primary px-3 text-xs font-bold text-primary-foreground", offset > 0 ? "opacity-100" : "opacity-0")} style={{ width: Math.max(0, offset) }}>
              <span className="overflow-hidden whitespace-nowrap">{rightLabel}</span>
            </span>
          )}
          {onLeft && (
            <span aria-hidden="true" className={cn("absolute inset-y-0 right-0 flex items-center justify-end bg-danger px-3 text-xs font-bold text-white", offset < 0 || leaving ? "opacity-100" : "opacity-0")} style={{ width: leaving ? w : Math.max(0, -offset) }}>
              <span className="overflow-hidden whitespace-nowrap">{leftLabel}</span>
            </span>
          )}
        </>
      )}
      <div
        data-testid="swipe-row-body"
        className={cn("relative bg-background", !dragging && "transition-[transform,opacity] ease-out motion-reduce:transition-none")}
        style={{ transform: x ? `translateX(${x}px)` : undefined, opacity: leaving ? 0 : undefined, transitionDuration: dragging ? "0ms" : `${SWIPE_ROW_EXIT_MS}ms` }}
      >
        {children}
      </div>
    </div>
  );
}
