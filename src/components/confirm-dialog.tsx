"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/** 削除・購入などの確認ダイアログ（Stage Collection-1）。確定の処理が終わるまで二重に実行しない。失敗したときはダイアログを開いたままエラーを表示する */
export function ConfirmDialog({ title, description, confirmLabel, danger = false, onConfirm, onClose, testId = "confirm" }: { title: string; description: string; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<string | null>; onClose: () => void; testId?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent data-testid={`${testId}-dialog`}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              キャンセル
            </Button>
          </DialogClose>
          <Button
            variant={danger ? "danger" : "default"}
            disabled={busy}
            data-testid={`${testId}-ok`}
            onClick={async () => {
              if (busy) return;
              setBusy(true);
              setError(null);
              const err = await onConfirm();
              setBusy(false);
              if (err) setError(err);
              else onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
