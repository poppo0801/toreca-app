"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * 画面上部に浮かせる短い通知（Undo付き）。スワイプ操作の結果を知らせ、約4.5秒のあいだ「元に戻す」を押せる。上へスワイプすると即座に閉じる（閉じても、操作はそのまま確定している。取り消せなくなるだけ）。
 *  ・position: fixed なので、見出しやカードを押し下げない。ノッチ・Dynamic Island・セーフエリアの内側に出す。
 *  ・body 直下に描画する。スクロール領域（main。iOS では -webkit-overflow-scrolling で独立した重なりの階層になる）の中に置くと、固定ヘッダーの裏に隠れて下の端しか見えなくなる。
 *  ・下部の細い進捗バーが、残り時間に合わせて左から右へ伸びる（アニメーションは CSS。動きを減らす設定でもバーは出す）。
 *  ・新しい操作が来たら通知を差し替える。「元に戻す」は常に今表示している操作だけを取り消す（取り違えない）。
 *  ・元に戻すが失敗したら、失敗を知らせる通知に切り替える（成功したように見せない）。
 */
export const UNDO_WINDOW_MS = 4500;
/** 上スワイプで閉じる判定（Stage 8U-1）: 上向きにこの距離（px）以上動かし、縦の動きが横の動きより大きいとき。これ未満の動きはタップ（元に戻す）として扱う */
export const DISMISS_SWIPE_PX = 28;
/** 動き始めとみなす距離（px）。これ未満は指の揺れ。超えたら、そのあとのクリックは無効にする */
const MOVE_SLOP_PX = 8;
/** 上スワイプで閉じるかの判定（純粋）。始点からの移動量（dx, dy。上が負）で決める */
export function isDismissSwipe(dx: number, dy: number): boolean {
  return dy <= -DISMISS_SWIPE_PX && Math.abs(dy) > Math.abs(dx) * 1.2;
}

export interface UndoToastInput {
  message: string;
  /** 取り消し処理。成功なら true（失敗は理由の文字列で返す）。省略した通知は「元に戻す」なし（エラー・情報の表示用） */
  undo?: () => Promise<true | string>;
  /** エラー通知（色を変える） */
  tone?: "default" | "error";
}

interface ToastState extends UndoToastInput {
  id: number;
  /** 取り消し実行中（連打しない） */
  pending: boolean;
}

interface UndoToastApi {
  show: (t: UndoToastInput) => void;
}

const Ctx = createContext<UndoToastApi | null>(null);

export function useUndoToast(): UndoToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("UndoToastProvider の外で useUndoToast が呼ばれました");
  return v;
}

export function UndoToastProvider({ children, windowMs = UNDO_WINDOW_MS }: { children: React.ReactNode; windowMs?: number }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const seq = useRef(0);
  const gesture = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const swallow = useRef(false);
  const [lift, setLift] = useState(0);
  const timer = useRef<number | null>(null);
  const host = useSyncExternalStore(
    () => () => undefined,
    () => document.body,
    () => null,
  );

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const dismiss = useCallback(
    (id: number) => {
      setToast((t) => (t?.id === id ? null : t));
    },
    [],
  );
  const show = useCallback(
    (t: UndoToastInput) => {
      clear();
      const id = ++seq.current;
      setToast({ ...t, id, pending: false });
      timer.current = window.setTimeout(() => dismiss(id), t.undo ? windowMs : Math.max(windowMs, 3500));
    },
    [clear, dismiss, windowMs],
  );
  useEffect(() => clear, [clear]);

  const runUndo = async () => {
    const cur = toast;
    if (!cur?.undo || cur.pending) return;
    clear();
    setToast({ ...cur, pending: true });
    let res: true | string;
    try {
      res = await cur.undo();
    } catch {
      res = "元に戻せませんでした。通信状況を確認してください";
    }
    // 取り消しの間に新しい操作の通知が出ていたら、古い取り消しの結果で上書きしない（新しい操作を隠さない）
    if (seq.current !== cur.id) return;
    if (res === true) show({ message: "元に戻しました" });
    else show({ message: res, tone: "error" });
  };

  const api = useMemo<UndoToastApi>(() => ({ show }), [show]);

  const onDown = (e: React.PointerEvent) => {
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    swallow.current = false;
  };
  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (Math.hypot(dx, dy) > MOVE_SLOP_PX) g.moved = true;
    // 上へ引いている間だけ追従（下・横には動かさない）
    setLift(dy < 0 && Math.abs(dy) > Math.abs(dx) ? dy : 0);
  };
  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    setLift(0);
    if (!g || g.id !== e.pointerId) return;
    if (g.moved) swallow.current = true; // 動いたあとのクリックは「元に戻す」にしない（タップと取り違えない）
    if (isDismissSwipe(e.clientX - g.x, e.clientY - g.y) && toast) {
      clear();
      dismiss(toast.id);
    }
  };
  const onCancel = () => {
    gesture.current = null;
    setLift(0);
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {toast && host && createPortal(
        <div
          // 画面上部に浮かせる。ノッチ・Dynamic Island・セーフエリアの内側（上端 + safe-area-inset-top）に置く
          className="pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-3"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 8px)" }}
          data-testid="undo-toast-wrap"
        >
          <div
            key={toast.id}
            role="status"
            aria-live="polite"
            data-testid="undo-toast"
            data-tone={toast.tone ?? "default"}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onCancel}
            style={{ touchAction: "none", transform: lift ? `translateY(${lift}px)` : undefined, opacity: lift ? Math.max(0.3, 1 + lift / 120) : undefined }}
            className={cn(
              "pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-xl border shadow-lg",
              toast.tone === "error" ? "border-danger bg-card text-danger" : "border-foreground/10 bg-foreground text-background",
            )}
          >
            <button
              type="button"
              disabled={!toast.undo || toast.pending}
              onClick={() => {
                if (swallow.current) {
                  swallow.current = false;
                  return;
                }
                void runUndo();
              }}
              className="flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left text-sm disabled:cursor-default"
              aria-label={toast.undo ? `${toast.message}。元に戻す` : toast.message}
            >
              <span className="min-w-0 flex-1 font-medium">{toast.tone === "error" ? "" : "✓ "}{toast.message}</span>
              {toast.undo && <span className="shrink-0 rounded-md border border-background/40 px-2 py-1 text-xs font-bold" data-testid="undo-button">{toast.pending ? "処理中…" : "元に戻す"}</span>}
            </button>
            {/* 残り時間の進捗バー（左から右へ伸びる） */}
            <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[3px] bg-background/20">
              <span className="undo-progress block h-full origin-left bg-primary" style={{ animationDuration: `${toast.undo ? windowMs : Math.max(windowMs, 3500)}ms` }} data-testid="undo-progress" />
            </span>
          </div>
        </div>,
        host,
      )}
    </Ctx.Provider>
  );
}
