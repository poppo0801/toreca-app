"use client";

import { useState } from "react";
import { useApp } from "@/components/app-provider";
import { ProductThumb } from "@/components/product-image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatQuantity } from "@/lib/lottery-view";
import type { Lottery } from "@/types/domain";

/**
 * 応募した商品の選択（複数商品・商品ごとに当落の抽選。Stage 7M）。
 * 応募時は初期状態で全商品を選択し、応募していない商品だけチェックを外す。1件も選ばなければ確定できない（応募済みにしない）。
 * 応募商品の変更では、全商品を外すと応募の取り消しになる（allowEmpty）。入力欄の自動フォーカスはしない。
 */
export function ItemPickerDialog({
  lottery,
  initial,
  title = "応募した商品を選択",
  confirmLabel = "応募済みにする",
  allowEmpty = false,
  lockedIds = [],
  onClose,
  onSubmit,
}: {
  lottery: Lottery;
  /** 最初にチェックを入れる商品の明細ID（既定は全商品） */
  initial?: string[];
  title?: string;
  confirmLabel?: string;
  /** 0件で確定できる（応募の取り消し）。応募商品の変更のときだけ */
  allowEmpty?: boolean;
  /** 当落が登録済みなどで外せない商品 */
  lockedIds?: string[];
  onClose: () => void;
  onSubmit: (itemIds: string[]) => Promise<void> | void;
}) {
  const { data, profile } = useApp();
  const all = lottery.items.flatMap((i) => (i.id ? [i.id] : []));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial ?? all));
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const zero = picked.size === 0;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent data-testid="item-picker" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{profile.label}が応募した商品にチェックを入れてください。他のユーザーの応募は変わりません。</DialogDescription>
        <ul className="mt-3 space-y-1.5">
          {lottery.items.map((it) => {
            if (!it.id) return null;
            const p = data.products.find((x) => x.id === it.productId);
            const locked = lockedIds.includes(it.id);
            return (
              <li key={it.id}>
                <label className="flex min-h-12 cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-sm has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5">
                  <input type="checkbox" className="size-5 shrink-0 accent-[var(--primary)]" checked={picked.has(it.id)} disabled={locked} onChange={() => toggle(it.id!)} data-testid="item-picker-check" aria-label={p?.officialName ?? "商品未登録"} />
                  <span className="flex h-9 w-7 shrink-0 items-center justify-center">
                    <ProductThumb product={p} heightClass="h-9" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p?.officialName ?? "商品未登録"}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatQuantity(it, p)}
                      {locked ? "・当落が登録済み" : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {zero && (
          <p className="mt-2 text-xs text-muted-foreground" role="status" data-testid="item-picker-zero">
            {allowEmpty ? "すべて外すと、応募を取り消します。" : "商品を1つ以上選択してください。"}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button
            type="button"
            disabled={busy || (zero && !allowEmpty)}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(all.filter((id) => picked.has(id)));
              } finally {
                setBusy(false);
              }
            }}
            data-testid="item-picker-ok"
          >
            {zero && allowEmpty ? "応募を取り消す" : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
