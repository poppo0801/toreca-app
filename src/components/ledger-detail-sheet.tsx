"use client";

import { useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { categoryOf } from "@/lib/expense-category";
import { flexToJstDate, productFullName, purchaseStoreName, purchaseTotal, UNIT_LABEL } from "@/lib/finance";
import { cn } from "@/lib/utils";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const CHANNEL: Record<string, string> = { store: "店頭", online: "通販・ネット", shipping: "発送（抽選・予約）", other: "その他" };
const ymd = (d: string | null) => (d ? d.replaceAll("-", "/") : "日付不明");

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/**
 * 収支の取引の詳細（下から開くシート）。取引日・分類・商品名・数量・金額・系列/店舗・メモなどの登録情報を確認し、
 * 「編集」で既存の入力フォーム（検証・連動処理もそのまま）へ、「削除」は確認のうえ実行する。商品名は正式名称の全文。
 */
export function LedgerDetailSheet({ kind, id, onClose, onEdit }: { kind: "expense" | "income"; id: string; onClose: () => void; onEdit: () => void }) {
  const { data, actions, persistent } = useApp();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const purchase = kind === "expense" ? data.purchases.find((p) => p.id === id) : undefined;
  const sale = kind === "income" ? data.sales.find((s) => s.id === id) : undefined;
  if (!purchase && !sale) return null;
  const fromLottery = purchase?.source === "lottery";
  const cat = purchase ? categoryOf(purchase.category) : null;
  const seller = sale ? data.profiles.find((p) => p.id === sale.sellerProfileId) : undefined;
  const sum = purchase ? purchaseTotal(purchase) : null;

  const remove = async () => {
    setBusy(true);
    setError(null);
    const res = purchase ? await actions.deleteExpense(purchase.id) : await actions.deleteSale(sale!.id);
    setBusy(false);
    if (res.ok) onClose();
    else setError(res.error);
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="ledger-detail-desc" data-testid="ledger-detail" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="px-4 pb-2">
          <SheetTitle>{purchase ? "支出の詳細" : "売却（収入）の詳細"}</SheetTitle>
          <SheetDescription id="ledger-detail-desc" className="sr-only">
            取引の登録内容です
          </SheetDescription>
        </div>
        <SheetBody className="border-t pt-2">
          <dl className="divide-y" data-testid="ledger-detail-fields">
            {purchase && cat && (
              <>
                <Field label="取引日">{ymd(flexToJstDate(purchase.purchasedOn))}</Field>
                <Field label="分類">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="inline-block h-3 w-1 rounded-full" style={{ background: cat.color }} />
                    {cat.short}
                    <span className="text-xs text-muted-foreground">（{cat.label}）</span>
                  </span>
                </Field>
                <Field label={cat.id === "expense" ? "内容" : "商品"}>
                  <ul className="space-y-1.5" data-testid="ledger-detail-items">
                    {purchase.items.map((it, i) => (
                      <li key={it.id ?? i} className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-words" data-testid="ledger-detail-name">
                          {productFullName(data, it.productId, it.productLabel)}
                          {cat.quantity && <span className="ml-1 text-xs text-muted-foreground">× {it.quantity}{UNIT_LABEL[it.unit]}</span>}
                        </span>
                        <span className="shrink-0 tabular-nums">{it.amountPaid === null ? <span className="text-xs text-muted-foreground">金額未入力</span> : yen(it.amountPaid)}</span>
                      </li>
                    ))}
                  </ul>
                </Field>
                <Field label="金額">
                  <span className="font-semibold tabular-nums" data-testid="ledger-detail-amount">
                    {sum && sum.unknown === purchase.items.length ? "金額未入力" : yen(sum?.total ?? 0)}
                  </span>
                </Field>
                <Field label="系列・店舗">{purchaseStoreName(data, purchase)}</Field>
                {cat.channel && <Field label="購入方法">{CHANNEL[purchase.channel] ?? purchase.channel}</Field>}
                {purchase.note && <Field label="メモ">{purchase.note}</Field>}
                <Field label="登録元">{fromLottery ? "抽選の当選・受取から作成" : "手入力"}</Field>
              </>
            )}
            {sale && (
              <>
                <Field label="取引日">{ymd(sale.soldOn)}</Field>
                <Field label="分類">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="inline-block h-3 w-1 rounded-full bg-info" />
                    売却（収入）
                  </span>
                </Field>
                <Field label="商品">
                  <span data-testid="ledger-detail-name">{productFullName(data, sale.productId, sale.productLabel)}</span>
                </Field>
                <Field label="数量">{sale.quantity}{UNIT_LABEL[sale.unit]}</Field>
                <Field label="金額">
                  <span className="font-semibold tabular-nums text-info" data-testid="ledger-detail-amount">
                    {yen(sale.amount)}
                  </span>
                </Field>
                <Field label="売却先">{sale.platform || "売却先未設定"}</Field>
                <Field label="売却名義人">{seller?.label ?? "—"}</Field>
                <Field label="原価">{sale.costAmount === null ? "未設定" : yen(sale.costAmount)}</Field>
                {(sale.fee > 0 || sale.shipping > 0) && <Field label="手数料・送料">{yen(sale.fee)}・{yen(sale.shipping)}</Field>}
                {sale.memo && <Field label="メモ">{sale.memo}</Field>}
              </>
            )}
          </dl>
          {error && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error}
            </p>
          )}
          {confirming && (
            <div className="mt-3 space-y-2 rounded-lg border border-danger p-3 text-sm" role="alertdialog" aria-label="削除の確認" data-testid="ledger-delete-confirm">
              <p>{purchase ? "この支出を削除しますか？（一覧から除かれ、購入実績にも含まれなくなります）" : "この売却記録を削除しますか？"}</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                  やめる
                </Button>
                <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()} data-testid="ledger-delete-run">
                  {busy ? "削除中…" : "削除する"}
                </Button>
              </div>
            </div>
          )}
        </SheetBody>
        <div className={cn("flex items-center justify-end gap-2 border-t bg-card px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]")}>
          {persistent && !fromLottery && !confirming && (
            <Button type="button" variant="outline" className="mr-auto" onClick={() => setConfirming(true)} data-testid="ledger-delete">
              削除
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            閉じる
          </Button>
          {persistent && (
            <Button type="button" onClick={onEdit} data-testid="ledger-edit">
              編集
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
