"use client";

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

  const purchased = data.purchases.length;

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
        <h2 id="purchase" className="mb-1 text-sm font-bold">購入履歴</h2>
        <p className="text-sm">当選からの購入記録: {purchased}件（個別明細）</p>
        <p className="mt-1 text-xs text-muted-foreground">
          過去の累計のみの実績（期首実績）は個別購入と別に表示する予定です。抽選外の購入入力はStage 2で追加します。
        </p>
      </section>

      <p className="text-xs text-muted-foreground">
        表示はすべて架空のサンプルデータです。対戦記録・相場・資産は後続のサブタブで追加予定です。
      </p>
    </div>
  );
}
