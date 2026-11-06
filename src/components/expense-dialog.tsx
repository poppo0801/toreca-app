"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { MasterCombobox, type MasterRef } from "@/components/master-combobox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { jstDateString } from "@/lib/datetime";
import { categoryOf, EXPENSE_CATEGORIES } from "@/lib/expense-category";
import { flexToJstDate, suggestedAmount } from "@/lib/finance";
import { expenseSchema } from "@/lib/finance-input";
import type { Purchase, PurchaseUnit } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";

interface ItemState {
  id: string | null;
  product: MasterRef;
  quantity: number;
  unit: PurchaseUnit;
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
  const [category, setCategory] = useState<string>(purchase?.category ?? "pokemon_card");
  const cat = categoryOf(category);
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

  // 品目を変えたら、入力済みの商品は引き継がない（マスターの商品と自由入力を混ぜない）。金額・日付・メモは残す
  const changeCategory = (next: string) => {
    if (next === category) return;
    const was = categoryOf(category);
    const to = categoryOf(next);
    setCategory(next);
    if (was.master !== to.master) setItems((s) => s.map((x) => ({ ...x, product: { id: null, name: "" }, unit: to.master ? x.unit : "piece", touched: true })));
    if (!to.channel) setChannel("other");
    else if (!was.channel) setChannel("store");
  };
  const suggest = (i: ItemState): number | null => !cat.master ? null : suggestedAmount(data.products.find((p) => p.id === i.product.id), i.unit, i.quantity);
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
      category,
      date,
      store: storeRef,
      channel,
      note,
      items: items.map((i) => ({
        id: i.id,
        product: i.product,
        quantity: cat.quantity ? i.quantity : 1,
        unit: cat.master ? i.unit : "piece",
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
      {/* 開いた直後に購入日（日付ピッカー・キーボード）が自動で開かないよう、最初のフォーカスは入力欄ではなくパネル自身にする */}
      <DialogContent className="max-w-lg" onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.focus?.(); }}>
        <DialogTitle>{isEdit ? "支出を編集" : "支出を登録"}</DialogTitle>
        <DialogDescription className={fromLottery ? undefined : "sr-only"}>
          {fromLottery ? "抽選の当選から作成された購入です。実際の購入日・店舗・数量・支払金額を確認して修正してください。" : "支出の入力"}
        </DialogDescription>
        <form onSubmit={submit} className="mt-3 space-y-3" noValidate>
          {/* 品目（先頭）。ポケモンカードは商品マスター・購入実績と連携。周辺グッズ・経費は自由入力で、購入実績には含めない */}
          <label className="block text-sm">
            <span className="block leading-5">品目</span>
            <select aria-label="品目" value={category} disabled={fromLottery} onChange={(e) => changeCategory(e.target.value)} className={`${field} h-11`} data-testid="expense-category">
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {/* 2列とも「上: 項目名 / 下: 入力」で揃える（iOS の日付入力は既定で高さ・内側の余白が違うので、同じ高さ・見た目に固定する） */}
          <div className={`grid items-start gap-2 ${cat.channel ? "grid-cols-2" : "grid-cols-1"}`}>
            <label className="block min-w-0 text-sm">
              <span className="block leading-5">購入日</span>
              <input type="date" aria-label="購入日" value={date} onChange={(e) => setDate(e.target.value)} className={`${field} h-11 min-w-0 text-left`} />
            </label>
            {cat.channel && (
            <label className="block min-w-0 text-sm">
              <span className="block leading-5">購入方法</span>
              <select aria-label="購入方法" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} className={`${field} block h-11 min-w-0`}>
                <option value="store">店頭</option>
                <option value="online">通販・ネット</option>
                <option value="shipping">発送（抽選・予約）</option>
                <option value="other">その他</option>
              </select>
            </label>
            )}
          </div>
          <div className="text-sm">
            {cat.master ? "購入店舗（未登録の店舗名も入力できます）" : "支払先（任意）"}
            <MasterCombobox label="購入店舗" value={storeRef} options={storeOptions} onChange={setStoreRef} placeholder="店舗を検索または入力" />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{cat.master ? "購入内容" : cat.id === "expense" ? "経費の内容" : "購入内容"}</legend>
            {items.map((it, i) => {
              const sug = suggest(it);
              return (
                <div key={i} className="space-y-1 rounded-md border p-2">
                  <div className="flex gap-2">
                    {cat.master ? (
                      <MasterCombobox
                        label={`商品${i + 1}`}
                        value={it.product}
                        options={productOptions}
                        className="min-w-0 flex-1"
                        onChange={(product) => patch(i, { product })}
                      />
                    ) : (
                      <input
                        type="text"
                        aria-label={`${cat.itemLabel}${i + 1}`}
                        value={it.product.name}
                        maxLength={120}
                        placeholder={cat.itemPlaceholder}
                        onChange={(e) => patch(i, { product: { id: null, name: e.target.value } })}
                        className={`${field} mt-0 min-w-0 flex-1`}
                        data-testid="expense-item-name"
                      />
                    )}
                    {items.length > 1 && !fromLottery && (
                      <Button type="button" variant="ghost" size="icon" aria-label={`商品${i + 1}を削除`} onClick={() => setItems((s) => s.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {cat.quantity && (
                    <input
                      type="number"
                      min={1}
                      aria-label={`数量${i + 1}`}
                      value={it.quantity}
                      onChange={(e) => patch(i, { quantity: Number(e.target.value) })}
                      className={`${field} mt-0 w-20`}
                    />
                    )}
                    {cat.master && <select aria-label={`単位${i + 1}`} value={it.unit} onChange={(e) => patch(i, { unit: e.target.value as ItemState["unit"] })} className={`${field} mt-0 w-28`}>
                      <option value="box">BOX</option>
                      <option value="pack">パック</option>
                      <option value="set">セット</option>
                      <option value="piece">個</option>
                    </select>}
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
                  {cat.master && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {sug !== null ? <span>定価から計算: {sug.toLocaleString("ja-JP")}円</span> : <span>定価が未設定のため金額は手入力です</span>}
                    {sug !== null && it.touched && String(sug) !== it.amount && (
                      <Button type="button" size="sm" variant="outline" onClick={() => patch(i, { amount: String(sug), touched: false })}>
                        定価で再計算
                      </Button>
                    )}
                  </div>}
                </div>
              );
            })}
            {!fromLottery && (
              <Button type="button" size="sm" variant="outline" onClick={() => setItems((s) => [...s, { id: null, product: { id: null, name: "" }, quantity: 1, unit: "box", amount: "", touched: false }])}>
                <Plus className="size-4" /> {cat.master ? "商品を追加" : "行を追加"}
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
