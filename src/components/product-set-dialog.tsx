"use client";

import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useApp } from "@/components/app-provider";
import { ProductThumb } from "@/components/product-image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { saveSetComposition } from "@/app/(app)/settings/masters/set-actions";

/**
 * セット商品の構成（含まれる商品と数量）の編集。
 * 構成は参照用の構造で、セットを購入しても構成商品の購入記録は増えない（金額・数量の二重計上をしない）。
 * 構成が分からないセットは空のままにできる（推測で登録しない）。
 */
export function SetCompositionButton({ productId, name }: { productId: string; name: string }) {
  const { data } = useApp();
  const count = (data.productSetItems ?? []).filter((s) => s.setProductId === productId).length;
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`${name}のセット構成を管理`}>
        構成{count > 0 ? `(${count})` : ""}
      </Button>
      {open && <SetCompositionDialog productId={productId} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function SetCompositionDialog({ productId, name, onClose }: { productId: string; name: string; onClose: () => void }) {
  const { data, profile, reload } = useApp();
  const [items, setItems] = useState<{ componentProductId: string; quantity: number }[]>(() =>
    (data.productSetItems ?? []).filter((s) => s.setProductId === productId).map((s) => ({ componentProductId: s.componentProductId, quantity: s.quantity })),
  );
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(
    () => data.products.filter((p) => p.id !== productId && !p.archived && !items.some((i) => i.componentProductId === p.id)),
    [data.products, items, productId],
  );
  const nameOf = (id: string) => data.products.find((p) => p.id === id);

  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await saveSetComposition({ setProductId: productId, actor: profile.id, items });
    setBusy(false);
    if (res.ok) {
      await reload();
      onClose();
    } else setError(res.error);
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <DialogTitle>セット構成</DialogTitle>
        <DialogDescription>
          「{name}」に含まれる商品と数量を登録します。構成は参考情報で、このセットを購入しても構成商品の購入金額・数量には加算されません。構成が分からない場合は空のままにしてください。
        </DialogDescription>
        <ul className="mt-3 space-y-2" aria-label="構成商品">
          {items.length === 0 && <li className="text-sm text-muted-foreground">構成は未登録です。</li>}
          {items.map((it, i) => {
            const p = nameOf(it.componentProductId);
            return (
              <li key={it.componentProductId} className="flex items-center gap-2 rounded-md border p-2" data-testid="set-component">
                <ProductThumb product={p} heightClass="h-10" />
                <span className="min-w-0 flex-1 truncate text-sm">{p?.officialName ?? "（不明な商品）"}</span>
                <input
                  type="number"
                  min={1}
                  max={999}
                  aria-label={`${p?.officialName ?? ""}の数量`}
                  value={it.quantity}
                  onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))}
                  className="min-h-10 w-16 rounded-md border bg-input px-2 text-sm"
                />
                <Button type="button" variant="ghost" size="icon" aria-label={`${p?.officialName ?? ""}を構成から外す`} onClick={() => setItems(items.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex gap-2">
          <select aria-label="構成に追加する商品" value={adding} onChange={(e) => setAdding(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-md border bg-input px-2 text-sm">
            <option value="">追加する商品を選択</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.officialName}
                {p.code ? `（${p.code}）` : ""}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            disabled={!adding}
            onClick={() => {
              setItems([...items, { componentProductId: adding, quantity: 1 }]);
              setAdding("");
            }}
          >
            <Plus className="size-4" /> 追加
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline">キャンセル</Button>
          </DialogClose>
          <Button onClick={save} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
