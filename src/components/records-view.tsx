"use client";

import Link from "next/link";
import { useApp } from "@/components/app-provider";

/** 少数標本の当選率は参考値扱い（requirements 3.1） */
const MIN_SAMPLE = 5;

export function RecordsView() {
  const { data } = useApp();
  const live = data.applications.filter((a) => a.state === "applied");

  const rows = data.chains.map((chain) => {
    const apps = live.filter((a) => data.lotteries.find((l) => l.id === a.lotteryId)?.chainId === chain.id);
    const decided = apps.filter((a) => a.result === "won" || a.result === "lost");
    const won = decided.filter((a) => a.result === "won").length;
    return { chain, applied: apps.length, decided: decided.length, won };
  });

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

      <p className="text-xs text-muted-foreground">
        購入履歴・収支は <Link href="/finance" className="underline underline-offset-2">収支</Link> ページに統合しました。モック時の表示は架空のサンプルデータです。
      </p>
    </div>
  );
}
