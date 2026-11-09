"use client";

import { useMemo, useRef, useState } from "react";
import { cancelOpeningAction, saveOpeningAction, updateOpeningAction } from "@/app/(app)/purchases/opening-actions";
import { useApp } from "@/components/app-provider";
import { MasterCombobox, type MasterRef } from "@/components/master-combobox";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { jstDateString } from "@/lib/datetime";
import { proratedAmount, type UnconfirmedPurchase } from "@/lib/usage-records";
import type { OpeningRecord } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";
const UNITS = [
  { value: "pack", label: "パック（単品）" },
  { value: "set", label: "セット（デッキ・カードセット）" },
  { value: "piece", label: "個（その他）" },
] as const;

/**
 * 開封・使用開始の記録（Stage 7K）。BOXはコレクションの「開封済みにする」で記録されるため、ここでは単品パック・デッキ・セット商品などを扱う。
 *  - new: 直接登録 / confirm: 開封状態が不明な購入を「開封済み」と確認（商品・単位は購入の明細に合わせ、金額は購入金額を数量で按分）/ edit: 既存の記録の修正と取り消し
 * 収支には何も書かない（新しい支出を作らない）。入力欄への自動フォーカスはしない。
 */
export function OpeningDialog({ mode, onClose }: { mode: { kind: "new" } | { kind: "confirm"; item: UnconfirmedPurchase } | { kind: "edit"; record: OpeningRecord }; onClose: () => void }) {
  const { data, profile, reload } = useApp();
  const opId = useRef(typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : null);
  const rec = mode.kind === "edit" ? mode.record : null;
  const item = mode.kind === "confirm" ? mode.item : null;
  const linked = !!item || !!rec?.purchaseItemId;
  const productOptions = useMemo(() => data.products.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.officialName, hint: p.code || undefined })), [data.products]);
  const [product, setProduct] = useState<MasterRef>(() => {
    const id = item?.productId ?? rec?.productId ?? null;
    const name = id ? (data.products.find((p) => p.id === id)?.officialName ?? "") : (item?.label ?? rec?.label ?? "");
    return { id, name };
  });
  const [unit, setUnit] = useState<"pack" | "set" | "piece">(item?.unit ?? rec?.unit ?? "pack");
  const [qty, setQty] = useState(String(item?.remaining ?? rec?.quantity ?? 1));
  const [date, setDate] = useState(rec?.openedOn ?? jstDateString(new Date()));
  const [amount, setAmount] = useState(() => {
    if (rec) return rec.amountYen === null ? "" : String(rec.amountYen);
    if (item) {
      const a = proratedAmount(item.amountPaid, item.quantity, item.remaining);
      return a === null ? "" : String(a);
    }
    return "";
  });
  const [owner, setOwner] = useState<string>(rec ? (rec.profileId ?? "") : profile.id);
  const note = rec?.note ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 購入に紐づく確認では、金額を数量に応じて按分し直す（金額を手で直した後は触らない）
  const amountTouched = useRef(false);
  const changeQty = (v: string) => {
    setQty(v);
    const q = Number(v);
    if (item && !amountTouched.current && Number.isInteger(q) && q >= 1 && q <= item.remaining) {
      const a = proratedAmount(item.amountPaid, item.quantity, q);
      setAmount(a === null ? "" : String(a));
    }
  };
  const n = Number(qty);
  const amountNum = amount.trim() === "" ? null : Number(amount.replace(/,/g, ""));
  const title = mode.kind === "edit" ? "開封の記録を編集" : mode.kind === "confirm" ? "開封済みにする" : "開封・使用開始を記録";

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!Number.isInteger(n) || n < 1) return setError("数量は1以上の整数で入力してください");
    if (item && n > item.remaining) return setError(`未確認の数量（${item.remaining}）を超えています`);
    if (amountNum !== null && (!Number.isInteger(amountNum) || amountNum < 0)) return setError("金額は0以上の整数（円）で入力してください");
    setBusy(true);
    const res =
      mode.kind === "edit"
        ? await updateOpeningAction(mode.record.id, { quantity: n, openedOn: date, amountYen: amountNum, profileId: owner || null, note })
        : await saveOpeningAction({ productId: product.id, label: product.id ? "" : product.name, quantity: n, unit, openedOn: date, amountYen: amountNum, profileId: owner || null, purchaseItemId: item?.itemId ?? null, note }, profile.id, opId.current);
    setBusy(false);
    if (res.ok) {
      await reload();
      onClose();
    } else setError(res.error);
  };
  const cancel = async () => {
    if (mode.kind !== "edit" || !window.confirm("この開封の記録を取り消しますか？（累計・履歴・金額から除かれます。購入の記録や在庫は変わりません）")) return;
    setBusy(true);
    const res = await cancelOpeningAction(mode.record.id);
    setBusy(false);
    if (res.ok) {
      await reload();
      onClose();
    } else setError(res.error);
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="opening-desc" data-testid="opening-form" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex items-start gap-2 px-4 pb-2 pt-1">
          <div className="min-w-0 flex-1">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription id="opening-desc" className="sr-only">
              開封・使用開始した商品の数量と金額を記録します。収支の支出は増えません
            </SheetDescription>
          </div>
          <SheetClose className="min-h-10 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted">閉じる</SheetClose>
        </div>
        <form onSubmit={save} noValidate className="flex min-h-0 flex-1 flex-col">
          <SheetBody className="space-y-3 border-t pt-3">
            {linked ? (
              <p className="text-sm font-medium" data-testid="opening-product">
                {product.name || "商品未登録"}
              </p>
            ) : (
              <div className="text-sm">
                <span className="text-[13px] font-medium">商品</span>
                <MasterCombobox label="商品" value={product} options={productOptions} onChange={setProduct} />
              </div>
            )}
            <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
              <label className="text-sm">
                <span className="text-[13px] font-medium">数量</span>
                <input type="number" inputMode="numeric" min={1} value={qty} onChange={(e) => changeQty(e.target.value)} className={field} aria-label="開封の数量" />
              </label>
              <label className="text-sm">
                <span className="text-[13px] font-medium">単位</span>
                <select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} disabled={linked} className={field} aria-label="開封の単位">
                  {UNITS.map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {item && <p className="text-xs text-muted-foreground">購入 {item.quantity}のうち、未確認 {item.remaining}。一部だけ開封済みにもできます（残りは未確認のまま）。</p>}
            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm">
                <span className="text-[13px] font-medium">開封・使用開始日</span>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} aria-label="開封・使用開始日" />
              </label>
              <label className="text-sm">
                <span className="text-[13px] font-medium">金額（円）</span>
                <input type="text" inputMode="numeric" value={amount} onChange={(e) => {
                    amountTouched.current = true;
                    setAmount(e.target.value);
                  }} placeholder="未設定" className={field} aria-label="開封分の購入金額" />
              </label>
            </div>
            <label className="block text-sm">
              <span className="text-[13px] font-medium">プロフィール</span>
              <select value={owner} onChange={(e) => setOwner(e.target.value)} className={field} aria-label="開封したプロフィール">
                <option value="">指定しない</option>
                {data.profiles
                  .filter((p) => p.active !== false)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
              </select>
            </label>
            <p className="text-[11px] text-muted-foreground">金額は、その商品を実際に購入したときの金額です（市場相場は使いません）。未設定の金額は0円として集計しません。</p>
            {error && (
              <p role="alert" className="text-sm text-danger" data-testid="opening-error">
                {error}
              </p>
            )}
          </SheetBody>
          <div className="flex items-center justify-between gap-2 border-t bg-card px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
            {mode.kind === "edit" ? (
              <Button type="button" variant="ghost" onClick={cancel} disabled={busy} className="text-danger" data-testid="opening-cancel">
                取り消す
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={busy} data-testid="opening-save">
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
