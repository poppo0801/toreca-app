"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { usePanelFocus } from "@/components/ui/initial-focus";

export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  const focus = usePanelFocus();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <DialogPrimitive.Content
        className={cn(
          // 位置と高さはキーボードを除いた表示領域（--kb-inset）の中央・範囲にする。入力欄がキーボードに隠れず、本文はスクロールでき、確定/キャンセルの操作が見える（Stage 7D）
          "fixed left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-lg border bg-card p-5 shadow-lg outline-none",
          className,
        )}
        {...focus}
        {...props}
        // キーボードを除いた表示領域の中央に置き、高さもその範囲に収める（--kb-inset は AppShell が visualViewport から更新する）
        style={{ top: "calc((100dvh - var(--kb-inset, 0px)) / 2)", maxHeight: "calc(100dvh - var(--kb-inset, 0px) - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 2rem)", ...props.style }}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-base font-semibold", className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("mt-2 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
