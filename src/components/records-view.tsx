"use client";

import { useState } from "react";
import { useApp } from "@/components/app-provider";
import { PurchaseDialog } from "@/components/purchase-dialog";
import { Button } from "@/components/ui/button";
import { formatFlexible, sortKey } from "@/lib/datetime";
import { formatItem } from "@/lib/lottery-view";
import type { Purchase } from "@/types/domain";

/** 少数標本の当選率は参考値扱い（requirements 3.1） */
const MIN_SAMPLE = 5;

export function RecordsView() {
  const { data, persistent } = useApp();
  const [adding, setAdding] = useState(false);
  const live = data.applications.filter((a) => a.state === "applied");

  const rows = data.chains.map((chain) => {
    const apps = live.filter((a) => data.lotteries.find((l) => l.id === a.lotteryId)?.chainId === chain.id);
    const decided = apps.filter((a) => a.result === "won" || a.result === "lost");
    const won = decided.filter((a) => a.result === "won").length;
    return { chain, applied: apps.length, decided: decided.length, won };
  });

  const recency = (p: Purchase) => (p.purchasedOn.precision === "unknown" ? -1 : sortKey(p.purchasedOn));
  const purchased = data.purchases.length;
  const sorted = [...data.purchases].sort((a, b) => recency(b) - recency(a));
  const storeName = (p: Purchase) => {
    const st = data.stores.find((x) => x.id === p.storeId);
    return st ? `${data.chains.find((c) => c.id === st.chainId)?.name ?? ""} ${st.name}` : "店舗不明";
  };
  const totals = data.purchases
    .flatMap((p) => p.items)
    .reduce(
      (acc, i) => {
        const per = data.products.find((x) => x.id === i.productId)?.packsPerBox;
        if (i.unit === "pack") acc.packs += i.quantity;
        else if (i.unit === "box" && per) acc.packs += i.quantity * per;
        acc.amount += i.amountPaid ?? 0;
        return acc;
      },
      { packs: 0, amount: 0 },
    );

  return (
    <div className="space-y-4">
      <section aria-labelledby="rate" className="rounded-lg border bg-card p-3">
        <h2 id="rate" className="mb-2 text-sm font-bold">系列別の応募・当選（個別応募データ）</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1">系列</th>
              <th scope="col" className="py-1 text-right">応募</th>
              <th scope="col" className="py-1 text-right">当選</th>
              <th scope="col" className="py-1 text-right">当選率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.chain.id} className="border-t">
                <th scope="row" className="py-1.5 text-left font-normal">{r.chain.name}</th>
                <td className="py-1.5 text-right">{r.applied}</td>
                <td className="py-1.5 text-right">{r.won}</td>
                <td className="py-1.5 text-right">
                  {r.decided === 0 ? (
                    "－"
                  ) : (
                    <>
                      {Math.round((r.won / r.decided) * 100)}%
                      {r.decided < MIN_SAMPLE && (
                        <span className="ml-1 text-xs text-muted-foreground">（参考値）</span>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">
          当落確定分のみで算出。標本が{MIN_SAMPLE}件未満の率は参考値です。
        </p>
      </section>

      <section aria-labelledby="purchase" className="rounded-lg border bg-card p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h2 id="purchase" className="text-sm font-bold">購入履歴</h2>
          {persistent && (
            <Button size="sm" onClick={() => setAdding(true)}>
              ＋ 購入を記録
            </Button>
          )}
        </div>
        {adding && <PurchaseDialog open onOpenChange={setAdding} />}
        <p className="mb-2 text-sm">
          {purchased}件（個別明細）{totals.packs > 0 && ` ・ 合計 ${totals.packs}P相当`}
          {totals.amount > 0 && ` ・ 金額判明分 ${totals.amount.toLocaleString("ja-JP")}円`}
        </p>
        <ul className="space-y-2" data-testid="purchase-list">
          {sorted.map((p) => (
            <li key={p.id} className="rounded-md border p-2 text-sm">
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>{p.purchasedOn.precision === "unknown" ? "日時不明" : formatFlexible(p.purchasedOn)}</span>
                <span>{storeName(p)}</span>
                <span className="rounded border px-1">{p.source === "lottery" ? "当選から" : p.source === "import" ? "取込" : "手入力"}</span>
              </p>
              <ul>
                {p.items.map((i, k) => (
                  <li key={k}>
                    {formatItem(i, data.products.find((x) => x.id === i.productId))}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {i.amountPaid === null ? "金額不明" : `${i.amountPaid.toLocaleString("ja-JP")}円`}
                    </span>
                  </li>
                ))}
              </ul>
              {p.note && <p className="text-xs text-muted-foreground">{p.note}</p>}
            </li>
          ))}
        </ul>
        {purchased === 0 && <p className="text-sm text-muted-foreground">まだ購入記録がありません。</p>}
        <p className="mt-2 text-xs text-muted-foreground">
          過去の累計のみの実績（期首実績）は個別購入と別に表示する予定です。
        </p>
      </section>

      <p className="text-xs text-muted-foreground">
        モック時の表示は架空のサンプルデータです。対戦記録・相場・資産は後続のサブタブで追加予定です。
      </p>
    </div>
  );
}
