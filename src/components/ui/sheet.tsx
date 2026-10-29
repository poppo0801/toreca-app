"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

export const Sheet = DialogPrimitive.Root;
export const SheetClose = DialogPrimitive.Close;

/**
 * 下から開くパネル（スマホ）。PC幅では中央のパネルとして表示する。
 * 上部のハンドルを下へスワイプすると閉じる（onSwipeDismiss があればそれを呼ぶ。例: 登録フォームの最小化）。
 * ハンドルのタップ・Enter/Space・背景のタップ・Escでも同じ操作ができる。スワイプはハンドルの上だけで受け付け、
 * 本文の縦スクロールでは閉じない。高さの上限は上部のSafe Area（ステータスバー・Dynamic Island）を除いた範囲。
 */
export function SheetContent({
  className,
  children,
  hideHandle = false,
  onSwipeDismiss,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { hideHandle?: boolean; onSwipeDismiss?: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const drag = React.useRef<{ y0: number; t0: number } | null>(null);

  const dismiss = () => (onSwipeDismiss ? onSwipeDismiss() : closeRef.current?.click());
  const setTransform = (value: string, transition: string) => {
    if (!ref.current) return;
    ref.current.style.transition = transition;
    ref.current.style.transform = value;
  };
  const onDown = (e: React.PointerEvent) => {
    drag.current = { y0: e.clientY, t0: e.timeStamp };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dy = Math.max(0, e.clientY - drag.current.y0);
    if (dy > 0) setTransform(`translateY(${dy}px)`, "none");
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dy = Math.max(0, e.clientY - d.y0);
    const speed = dy / Math.max(1, e.timeStamp - d.t0);
    if (dy < 6) {
      setTransform("", "");
      dismiss(); // タップ
    } else if (dy > 110 || (dy > 40 && speed > 0.5)) {
      setTransform("translateY(100%)", "transform 0.16s ease-in");
      window.setTimeout(dismiss, 150);
    } else {
      setTransform("translateY(0)", "transform 0.18s ease-out");
    }
  };
  const onCancel = () => {
    drag.current = null;
    setTransform("translateY(0)", "transform 0.18s ease-out");
  };

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-[fade-in_0.15s_ease-out]" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed inset-x-0 bottom-[calc(var(--vp-gap,0px)*-1)] z-50 flex max-h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] flex-col rounded-t-2xl border border-b-0 bg-card text-card-foreground shadow-[var(--shadow-sheet)] outline-none",
          "data-[state=open]:animate-[sheet-in_0.22s_ease-out] data-[state=closed]:animate-[sheet-out_0.18s_ease-in]",
          "md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[90dvh] md:w-[calc(100%-2rem)] md:max-w-xl md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:data-[state=open]:animate-none md:data-[state=closed]:animate-none",
          className,
        )}
        {...props}
      >
        {!hideHandle && (
          <div
            role="button"
            tabIndex={0}
            aria-label="下へスワイプまたはタップで閉じる"
            data-testid="sheet-handle"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onCancel}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                dismiss();
              }
            }}
            className="flex h-7 w-full shrink-0 cursor-grab touch-none items-center justify-center md:hidden"
          >
            <span aria-hidden="true" className="h-1 w-10 rounded-full bg-muted-foreground/40" />
          </div>
        )}
        <DialogPrimitive.Close ref={closeRef} className="sr-only" tabIndex={-1} aria-hidden="true" />
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-base font-bold", className)} {...props} />;
}

export function SheetDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

/** スクロールする本文領域。下端の余白に Safe Area を含める */
export function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]", className)} {...props} />;
}
