"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { manualPurchaseSchema } from "@/lib/purchase-input";
import { cn } from "@/lib/utils";

const field = "mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-sm";

interface ItemState {
  productId: string;
  quantity: number;
  unit: "box" | "pack" | "set";
  /** 空欄=金額不明（0円とは別） */
  amount: string;
}

/** 抽選外の購入（一般販売・店頭購入など）の手入力。日時・金額が不明なら空欄のまま保存できる。 */
export function PurchaseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, actions } = useApp();
  const [storeId, setStoreId] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [channel, setChannel] = useState<"store" | "shipping" | "online" | "other">("store");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<ItemState[]>([{ productId: "", quantity: 1, unit: "box", amount: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, p: Partial<ItemState>) => setItems((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const input = {
      storeId,
      date,
      time,
      channel,
      note,
      items: items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        unit: i.unit,
        amountPaid: i.amount.trim() === "" ? null : Number(i.amount),
      })),
    };
    const parsed = manualPurchaseSchema.safeParse(input);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
    setBusy(true);
    const res = await actions.addManualPurchase(input);
    setBusy(false);
    if (res.ok) onOpenChange(false);
    else setError(res.error);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto">
        <DialogTitle>購入を記録</DialogTitle>
        <DialogDescription>抽選に関係ない購入も記録できます。不明な項目は空欄のままで構いません。</DialogDescription>
        <form onSubmit={submit} className="mt-3 space-y-3" noValidate>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              購入日（任意）
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
            </label>
            <label className="text-sm">
              時刻（任意）
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={field} disabled={!date} />
            </label>
            <label className="text-sm">
              店舗（任意）
              <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={field}>
                <option value="">不明・未選択</option>
                {data.stores
                  .filter((s) => !s.archived)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {data.chains.find((c) => c.id === s.chainId)?.name} {s.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="text-sm">
              購入方法
              <select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} className={field}>
                <option value="store">店頭</option>
                <option value="shipping">発送（当選等）</option>
                <option value="online">通販</option>
                <option value="other">その他</option>
              </select>
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">購入内容</legend>
            {items.map((it, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <select
                  aria-label={`商品${i + 1}`}
                  value={it.productId}
                  onChange={(e) => patch(i, { productId: e.target.value })}
                  className={cn(field, "mt-0 min-w-0 flex-1")}
                >
                  <option value="">商品不明</option>
                  {data.products
                    .filter((p) => !p.archived)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.officialName}
                      </option>
                    ))}
                </select>
                <input
                  type="number"
                  min={1}
                  aria-label={`数量${i + 1}`}
                  value={it.quantity}
                  onChange={(e) => patch(i, { quantity: Number(e.target.value) })}
                  className={cn(field, "mt-0 w-20")}
                />
                <select
                  aria-label={`単位${i + 1}`}
                  value={it.unit}
                  onChange={(e) => patch(i, { unit: e.target.value as ItemState["unit"] })}
                  className={cn(field, "mt-0 w-24")}
                >
                  <option value="box">BOX</option>
                  <option value="pack">パック</option>
                  <option value="set">セット</option>
                </select>
                <input
                  type="number"
                  min={0}
                  aria-label={`金額${i + 1}（円）`}
                  placeholder="金額(円)・不明は空欄"
                  value={it.amount}
                  onChange={(e) => patch(i, { amount: e.target.value })}
                  className={cn(field, "mt-0 w-40")}
                />
                {items.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`購入内容${i + 1}を削除`}
                    onClick={() => setItems((s) => s.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setItems((s) => [...s, { productId: "", quantity: 1, unit: "box", amount: "" }])}
            >
              <Plus className="size-4" /> 行を追加
            </Button>
          </fieldset>
          <label className="block text-sm">
            メモ
            <input value={note} onChange={(e) => setNote(e.target.value)} className={field} />
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                キャンセル
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
