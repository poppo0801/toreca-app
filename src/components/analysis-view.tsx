"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { jstDateString } from "@/lib/datetime";
import { annualStats, type SellerStats } from "@/lib/finance";
import { cn } from "@/lib/utils";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

function StatsTable({ stats }: { stats: SellerStats }) {
  const rows: [string, string, string?][] = [
    ["売却額", yen(stats.salesAmount), `${stats.salesCount}件`],
    ["購入原価（確定分）", yen(stats.costKnown)],
    ["手数料・送料", yen(stats.fee + stats.shipping)],
    ["売却利益（原価確定分）", `${stats.profitKnown < 0 ? "-" : ""}${yen(Math.abs(stats.profitKnown))}`],
  ];
  return (
    <>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
        {rows.map(([k, v, sub]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right font-medium">
              {v}
              {sub && <span className="ml-1 text-xs font-normal text-muted-foreground">{sub}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {stats.costUnknownCount > 0 && (
        <p className="mt-1.5 rounded bg-muted px-2 py-1 text-xs" data-testid="cost-unknown">
          原価未設定の取引 {stats.costUnknownCount}件（売却額 {yen(stats.amountCostUnknown)}）は利益未確定です。上の利益には含めていません。
        </p>
      )}
    </>
  );
}

/**
 * 年間の売却実績と参考利益。売却金額から購入原価・手数料・送料を差し引いた参考値で、税務申告用の厳密な計算ではない。
 * 原価未設定は 0円とみなさず「利益未確定」として分けて集計する。
 */
export function AnalysisView() {
  const { data } = useApp();
  const [year, setYear] = useState(() => Number(jstDateString(new Date()).slice(0, 4)));
  const { total, bySeller } = useMemo(() => annualStats(data, year), [data, year]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-base font-bold">年間売却実績・収益分析</h1>
        <Link href="/finance" className="text-sm underline underline-offset-2">
          収支へ戻る
        </Link>
      </div>
      <div className="flex items-center justify-between rounded-lg bg-card px-1 py-0.5">
        <Button variant="ghost" size="icon" className="size-10" aria-label="前の年" onClick={() => setYear((y) => y - 1)}>
          <ChevronLeft className="size-5" />
        </Button>
        <span className="text-sm font-semibold" data-testid="year-label">{year}年</span>
        <Button variant="ghost" size="icon" className="size-10" aria-label="次の年" onClick={() => setYear((y) => y + 1)}>
          <ChevronRight className="size-5" />
        </Button>
      </div>

      <section aria-label="家族全体の合計" className="rounded-lg border bg-card p-3" data-testid="annual-total">
        <h2 className="mb-1.5 text-sm font-bold">家族全体の合計</h2>
        <StatsTable stats={total} />
      </section>

      {data.profiles
        .filter((p) => p.active !== false)
        .map((p) => {
          const st = bySeller.find((s) => s.sellerProfileId === p.id);
          return (
            <section key={p.id} aria-label={`${p.label}の売却実績`} className="rounded-lg border bg-card p-3" data-testid="annual-seller">
              <h2 className="mb-1.5 flex items-center gap-2 text-sm font-bold">
                <ProfileAvatar profile={p} size="sm" />
                {p.label}
              </h2>
              {st ? <StatsTable stats={st} /> : <p className={cn("text-sm text-muted-foreground")}>この年の売却はありません。</p>}
            </section>
          );
        })}
      <p className="text-xs text-muted-foreground">
        参考利益 = 売却金額 − 購入原価 − 販売手数料 − 送料。売却名義人は実際に売却手続きを行った人で、所得の帰属を示すものではありません。推移グラフや相場分析は今後の拡張で追加します。
      </p>
    </div>
  );
}
