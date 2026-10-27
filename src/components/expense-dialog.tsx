"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { MasterCombobox, type MasterRef } from "@/components/master-combobox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { jstDateString } from "@/lib/datetime";
import { flexToJstDate, suggestedAmount } from "@/lib/finance";
import { expenseSchema } from "@/lib/finance-input";
import type { Purchase } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";

interface ItemState {
  id: string | null;
  product: MasterRef;
  quantity: number;
  unit: "box" | "pack" | "set";
  /** 空欄=金額不明（0円とは別） */
  amount: string;
  /** 利用者が金額を直接編集したか。true の間は数量/商品を変えても自動で上書きしない */
  touched: boolean;
}

/**
 * 支出（購入）の登録・編集。商品はマスターから選ぶか、未登録ならそのまま入力できる。
 * 定価がある商品は数量から金額を仮計算するが、手で直した金額は上書きしない（「定価で再計算」で明示的に戻せる）。
 * 抽選の当選から作られた購入も、日付・店舗・数量・金額をここで確認・修正できる。
 */
export function ExpenseDialog({ open, onOpenChange, purchase }: { open: boolean; onOpenChange: (v: boolean) => void; purchase: Purchase | null }) {
  const { data, actions } = useApp();
  const isEdit = purchase !== null;
  const store = purchase?.storeId ? data.stores.find((s) => s.id === purchase.storeId) : undefined;
  const [date, setDate] = useState(() => (purchase ? (flexToJstDate(purchase.purchasedOn) ?? "") : jstDateString(new Date())));
  const [storeRef, setStoreRef] = useState<MasterRef>(() => ({ id: store?.id ?? null, name: store?.name ?? purchase?.storeLabel ?? "" }));
  const [channel, setChannel] = useState<"store" | "shipping" | "online" | "other">(purchase?.channel ?? "store");
  const [note, setNote] = useState(purchase?.note ?? "");
  const [items, setItems] = useState<ItemState[]>(() =>
    purchase
      ? purchase.items.map((i) => ({
          id: i.id ?? null,
          product: { id: i.productId, name: data.products.find((p) => p.id === i.productId)?.officialName ?? i.productLabel ?? "" },
          quantity: i.quantity,
          unit: i.unit as ItemState["unit"],
          amount: i.amountPaid === null ? "" : String(i.amountPaid),
          touched: true,
        }))
      : [{ id: null, product: { id: null, name: "" }, quantity: 1, unit: "box", amount: "", touched: false }],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const storeOptions = useMemo(
    () => data.stores.filter((s) => !s.archived || s.id === store?.id).map((s) => ({ id: s.id, name: s.name, hint: data.chains.find((c) => c.id === s.chainId)?.name })),
    [data.stores, data.chains, store?.id],
  );
  const productOptions = useMemo(
    () => data.products.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.officialName, hint: p.code || undefined })),
    [data.products],
  );

  const suggest = (i: ItemState): number | null => suggestedAmount(data.products.find((p) => p.id === i.product.id), i.unit, i.quantity);
  /** 項目を更新し、金額が未編集で定価がわかる場合だけ仮計算を反映する */
  const patch = (idx: number, p: Partial<ItemState>) =>
    setItems((s) =>
      s.map((x, j) => {
        if (j !== idx) return x;
        const next = { ...x, ...p };
        if (!next.touched && p.amount === undefined) {
          const sug = suggest(next);
          next.amount = sug === null ? "" : String(sug);
        }
        return next;
      }),
    );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const input = {
      date,
      store: storeRef,
      channel,
      note,
      items: items.map((i) => ({
        id: i.id,
        product: i.product,
        quantity: i.quantity,
        unit: i.unit,
        amountPaid: i.amount.trim() === "" ? null : Number(i.amount),
      })),
    };
    const parsed = expenseSchema.safeParse(input);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
    setBusy(true);
    const res = await actions.saveExpense(purchase?.id ?? null, input);
    setBusy(false);
    if (res.ok) onOpenChange(false);
    else setError(res.error);
  };

  const remove = async () => {
    if (!purchase || !window.confirm("この支出を削除しますか？（一覧から除かれ、購入実績にも含まれなくなります）")) return;
    setBusy(true);
    const res = await actions.deleteExpense(purchase.id);
    setBusy(false);
    if (res.ok) onOpenChange(false);
    else setError(res.error);
  };

  const fromLottery = purchase?.source === "lottery";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{isEdit ? "支出を編集" : "支出を登録"}</DialogTitle>
        <DialogDescription>
          {fromLottery
            ? "抽選の当選から作成された購入です。実際の購入日・店舗・数量・支払金額を確認して修正してください。"
            : "購入した商品を記録します。マスター登録済みの商品は購入実績にも自動で反映されます。"}
        </DialogDescription>
        <form onSubmit={submit} className="mt-3 space-y-3" noValidate>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              購入日
              <input type="date" aria-label="購入日" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
            </label>
            <label className="text-sm">
              購入方法
              <select aria-label="購入方法" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} className={field}>
                <option value="store">店頭</option>
                <option value="online">通販・ネット</option>
                <option value="shipping">発送（抽選・予約）</option>
                <option value="other">その他</option>
              </select>
            </label>
          </div>
          <div className="text-sm">
            購入店舗（未登録の店舗名も入力できます）
            <MasterCombobox label="購入店舗" value={storeRef} options={storeOptions} onChange={setStoreRef} placeholder="店舗を検索または入力" />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">購入内容</legend>
            {items.map((it, i) => {
              const sug = suggest(it);
              return (
                <div key={i} className="space-y-1 rounded-md border p-2">
                  <div className="flex gap-2">
                    <MasterCombobox
                      label={`商品${i + 1}`}
                      value={it.product}
                      options={productOptions}
                      className="min-w-0 flex-1"
                      onChange={(product) => patch(i, { product })}
                    />
                    {items.length > 1 && !fromLottery && (
                      <Button type="button" variant="ghost" size="icon" aria-label={`商品${i + 1}を削除`} onClick={() => setItems((s) => s.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="number"
                      min={1}
                      aria-label={`数量${i + 1}`}
                      value={it.quantity}
                      onChange={(e) => patch(i, { quantity: Number(e.target.value) })}
                      className={`${field} mt-0 w-20`}
                    />
                    <select aria-label={`単位${i + 1}`} value={it.unit} onChange={(e) => patch(i, { unit: e.target.value as ItemState["unit"] })} className={`${field} mt-0 w-28`}>
                      <option value="box">BOX</option>
                      <option value="pack">パック</option>
                      <option value="set">セット</option>
                    </select>
                    <input
                      type="number"
                      min={0}
                      inputMode="numeric"
                      aria-label={`購入金額${i + 1}`}
                      placeholder="金額(円)"
                      value={it.amount}
                      onChange={(e) => patch(i, { amount: e.target.value, touched: true })}
                      className={`${field} mt-0 w-32 min-w-0 flex-1`}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {sug !== null ? <span>定価から計算: {sug.toLocaleString("ja-JP")}円</span> : <span>定価が未設定のため金額は手入力です</span>}
                    {sug !== null && it.touched && String(sug) !== it.amount && (
                      <Button type="button" size="sm" variant="outline" onClick={() => patch(i, { amount: String(sug), touched: false })}>
                        定価で再計算
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {!fromLottery && (
              <Button type="button" size="sm" variant="outline" onClick={() => setItems((s) => [...s, { id: null, product: { id: null, name: "" }, quantity: 1, unit: "box", amount: "", touched: false }])}>
                <Plus className="size-4" /> 商品を追加
              </Button>
            )}
          </fieldset>

          <label className="block text-sm">
            メモ
            <textarea aria-label="メモ" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`${field} py-2`} />
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            {isEdit && !fromLottery ? (
              <Button type="button" variant="outline" onClick={remove} disabled={busy}>
                削除
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  キャンセル
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
