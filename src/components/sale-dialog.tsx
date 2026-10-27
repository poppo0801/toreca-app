"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/app-provider";
import { MasterCombobox, type MasterRef } from "@/components/master-combobox";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { jstDateString } from "@/lib/datetime";
import { costCandidates, proratedCost, UNIT_LABEL } from "@/lib/finance";
import { saleSchema } from "@/lib/finance-input";
import { readPref, writePref } from "@/services/local-device-store";
import type { Sale } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";
const SELLER_KEY = "seller";

type CostMode = "none" | "manual" | "link";

/**
 * 売却（収入）の登録・編集。売却名義人は実際に売却手続きを行った人で、初期値は前回使った名義人。
 * 購入原価は未設定にできる（0円とはみなさず、利益は未確定として集計される）。購入履歴から原価を紐づけると、
 * 同じ購入分を別の売却の原価に重複して使えない（数量の残りで制限）。
 */
export function SaleDialog({ open, onOpenChange, sale }: { open: boolean; onOpenChange: (v: boolean) => void; sale: Sale | null }) {
  const { data, profile, actions } = useApp();
  const isEdit = sale !== null;
  const profiles = data.profiles.filter((p) => p.active !== false);
  const [soldOn, setSoldOn] = useState(sale?.soldOn ?? jstDateString(new Date()));
  const [platform, setPlatform] = useState(sale?.platform ?? "");
  const [product, setProduct] = useState<MasterRef>(() => ({
    id: sale?.productId ?? null,
    name: data.products.find((p) => p.id === sale?.productId)?.officialName ?? sale?.productLabel ?? "",
  }));
  const [quantity, setQuantity] = useState(sale?.quantity ?? 1);
  const [unit, setUnit] = useState<Sale["unit"]>(sale?.unit ?? "box");
  const [amount, setAmount] = useState(sale ? String(sale.amount) : "");
  const [seller, setSeller] = useState(() => {
    if (sale) return sale.sellerProfileId;
    const saved = readPref(SELLER_KEY, profiles.map((p) => p.id), profile.id);
    return saved;
  });
  const [costMode, setCostMode] = useState<CostMode>(sale ? (sale.costPurchaseItemId ? "link" : sale.costAmount !== null ? "manual" : "none") : "none");
  const [costAmount, setCostAmount] = useState(sale?.costAmount != null ? String(sale.costAmount) : "");
  const [linkItem, setLinkItem] = useState(sale?.costPurchaseItemId ?? "");
  const [linkQty, setLinkQty] = useState(sale?.costQuantity ?? 1);
  const [fee, setFee] = useState(String(sale?.fee ?? 0));
  const [shipping, setShipping] = useState(String(sale?.shipping ?? 0));
  const [memo, setMemo] = useState(sale?.memo ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const productOptions = useMemo(
    () => data.products.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.officialName, hint: p.code || undefined })),
    [data.products],
  );
  const candidates = useMemo(() => costCandidates(data, sale?.id), [data, sale?.id]);
  const picked = candidates.find((c) => c.itemId === linkItem);
  const linkedCost = picked ? proratedCost(picked.amountPaid, picked.quantity, linkQty) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const linked = costMode === "link" && picked;
    if (costMode === "link" && !picked) return setError("原価に使う購入を選択してください");
    if (linked && linkQty > picked.remaining) return setError(`この購入の残り数量は${picked.remaining}です`);
    const input = {
      soldOn,
      platform,
      product,
      quantity,
      unit,
      amount: Number(amount === "" ? NaN : amount),
      sellerProfileId: seller,
      costAmount: costMode === "manual" ? (costAmount.trim() === "" ? null : Number(costAmount)) : linked ? (costAmount.trim() !== "" ? Number(costAmount) : linkedCost) : null,
      costPurchaseItemId: linked ? picked.itemId : null,
      costQuantity: linked ? linkQty : null,
      fee: Number(fee || 0),
      shipping: Number(shipping || 0),
      memo,
    };
    const parsed = saleSchema.safeParse(input);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
    setBusy(true);
    const res = await actions.saveSale(sale?.id ?? null, input);
    setBusy(false);
    if (res.ok) {
      writePref(SELLER_KEY, seller);
      onOpenChange(false);
    } else setError(res.error);
  };

  const remove = async () => {
    if (!sale || !window.confirm("この売却記録を削除しますか？")) return;
    setBusy(true);
    const res = await actions.deleteSale(sale.id);
    setBusy(false);
    if (res.ok) onOpenChange(false);
    else setError(res.error);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{isEdit ? "売却を編集" : "売却（収入）を登録"}</DialogTitle>
        <DialogDescription>売却名義人は、実際に売却手続きを行った人です。確定申告用の所得計算ではなく、家族の取引の振り返り用です。</DialogDescription>
        <form onSubmit={submit} className="mt-3 space-y-3" noValidate>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              売却日
              <input type="date" aria-label="売却日" value={soldOn} onChange={(e) => setSoldOn(e.target.value)} className={field} />
            </label>
            <label className="text-sm">
              売却店舗・サービス
              <input aria-label="売却店舗・サービス" value={platform} onChange={(e) => setPlatform(e.target.value)} maxLength={80} placeholder="例: 買取店、フリマ" className={field} />
            </label>
          </div>
          <div className="text-sm">
            売却商品（未登録の商品名も入力できます）
            <MasterCombobox label="売却商品" value={product} options={productOptions} onChange={setProduct} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-sm">
              数量
              <input type="number" min={1} aria-label="売却数量" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className={field} />
            </label>
            <label className="text-sm">
              単位
              <select aria-label="売却単位" value={unit} onChange={(e) => setUnit(e.target.value as Sale["unit"])} className={field}>
                {(["box", "pack", "set", "piece"] as const).map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABEL[u]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              売却金額(円)
              <input type="number" min={0} inputMode="numeric" aria-label="売却金額" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} />
            </label>
          </div>

          <fieldset>
            <legend className="text-sm">売却名義人</legend>
            <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup" aria-label="売却名義人">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={seller === p.id}
                  onClick={() => setSeller(p.id)}
                  className={`flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm ${seller === p.id ? "border-primary bg-muted font-medium" : "hover:bg-muted"}`}
                >
                  <ProfileAvatar profile={p} size="sm" />
                  {p.label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-1.5 rounded-md border p-2">
            <legend className="px-1 text-sm">購入原価</legend>
            <div className="flex flex-wrap gap-3 text-sm">
              {(
                [
                  ["none", "未設定（利益は未確定）"],
                  ["manual", "手入力"],
                  ["link", "購入履歴から選ぶ"],
                ] as const
              ).map(([v, t]) => (
                <label key={v} className="flex min-h-10 items-center gap-1.5">
                  <input type="radio" name="costmode" checked={costMode === v} onChange={() => setCostMode(v)} className="size-4" />
                  {t}
                </label>
              ))}
            </div>
            {costMode === "manual" && (
              <input type="number" min={0} inputMode="numeric" aria-label="購入原価" placeholder="原価(円)" value={costAmount} onChange={(e) => setCostAmount(e.target.value)} className={field} />
            )}
            {costMode === "link" && (
              <div className="space-y-1.5">
                <select aria-label="原価にする購入" value={linkItem} onChange={(e) => { setLinkItem(e.target.value); setLinkQty(1); }} className={field}>
                  <option value="">購入を選択（未使用の数量が残っているもの）</option>
                  {candidates.map((c) => (
                    <option key={c.itemId} value={c.itemId}>
                      {c.date ?? "日付不明"} {c.label}（残り{c.remaining}{UNIT_LABEL[c.unit]}）
                    </option>
                  ))}
                </select>
                {picked && (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      原価にする数量
                      <input type="number" min={1} max={picked.remaining} aria-label="原価にする数量" value={linkQty} onChange={(e) => setLinkQty(Number(e.target.value))} className="min-h-11 w-24 rounded-md border bg-input px-3" />
                      <span className="text-xs text-muted-foreground">（残り{picked.remaining}）</span>
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {linkedCost === null ? "この購入の金額が未入力のため、原価は未確定になります（下で手入力も可能）" : `按分した原価: ${linkedCost.toLocaleString("ja-JP")}円`}
                    </p>
                    <input type="number" min={0} inputMode="numeric" aria-label="原価の上書き" placeholder="原価を手で直す場合のみ入力(円)" value={costAmount} onChange={(e) => setCostAmount(e.target.value)} className={field} />
                  </>
                )}
              </div>
            )}
          </fieldset>

          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              販売手数料(円)
              <input type="number" min={0} inputMode="numeric" aria-label="販売手数料" value={fee} onChange={(e) => setFee(e.target.value)} className={field} />
            </label>
            <label className="text-sm">
              送料(円)
              <input type="number" min={0} inputMode="numeric" aria-label="送料" value={shipping} onChange={(e) => setShipping(e.target.value)} className={field} />
            </label>
          </div>
          <label className="block text-sm">
            メモ
            <textarea aria-label="メモ" value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} className={`${field} py-2`} />
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            {isEdit ? (
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
