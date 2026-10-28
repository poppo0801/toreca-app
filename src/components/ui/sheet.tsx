"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

export const Sheet = DialogPrimitive.Root;
export const SheetClose = DialogPrimitive.Close;

/**
 * 下から開くパネル（スマホ）。PC幅では中央のパネルとして表示する。
 * 下端はホームインジケーター分の Safe Area を確保し、高さは画面の約9割まで（内部をスクロール）。
 */
export function SheetContent({
  className,
  children,
  hideHandle = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { hideHandle?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-[fade-in_0.15s_ease-out]" />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-2xl border border-b-0 bg-card text-card-foreground shadow-[var(--shadow-sheet)] outline-none",
          "data-[state=open]:animate-[sheet-in_0.22s_ease-out] data-[state=closed]:animate-[sheet-out_0.18s_ease-in]",
          "md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-[calc(100%-2rem)] md:max-w-xl md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:data-[state=open]:animate-none md:data-[state=closed]:animate-none",
          className,
        )}
        {...props}
      >
        {!hideHandle && <span aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/40 md:hidden" />}
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
