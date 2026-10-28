"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { jstDateString } from "@/lib/datetime";
import { periodLabel, shiftPeriod, type Period, type PeriodKind } from "@/lib/purchase-records";
import { computeWinStats, formatRate, MIN_SAMPLE, type RateRow } from "@/lib/win-rate";
import { cn } from "@/lib/utils";

const KINDS: { value: PeriodKind; label: string }[] = [
  { value: "month", label: "当月" },
  { value: "year", label: "年間" },
  { value: "all", label: "全期間" },
];

function RateTable({ title, rows, labelHead, testId, limit }: { title: string; rows: RateRow[]; labelHead: string; testId: string; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = limit && !all ? rows.slice(0, limit) : rows;
  return (
    <section aria-label={title} className="rounded-xl border bg-card p-3 shadow-card" data-testid={testId}>
      <h2 className="mb-1.5 text-sm font-bold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">この条件の応募はありません。</p>
      ) : (
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-1 font-normal">
                {labelHead}
              </th>
              <th scope="col" className="w-9 py-1 text-right font-normal">
                応募
              </th>
              <th scope="col" className="w-9 py-1 text-right font-normal">
                当選
              </th>
              <th scope="col" className="w-9 py-1 text-right font-normal">
                落選
              </th>
              <th scope="col" className="w-11 py-1 text-right font-normal">
                未確認
              </th>
              <th scope="col" className="w-14 py-1 text-right font-normal">
                当選率
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className="border-t" data-testid="rate-row">
                <th scope="row" className="truncate py-1.5 pr-1 text-left font-normal" title={r.label}>
                  {r.label}
                </th>
                <td className="py-1.5 text-right tabular-nums">{r.applied}</td>
                <td className="py-1.5 text-right tabular-nums">{r.won}</td>
                <td className="py-1.5 text-right tabular-nums">{r.lost}</td>
                <td className="py-1.5 text-right tabular-nums">{r.pending}</td>
                <td className={cn("py-1.5 text-right tabular-nums", r.lowSample && "text-muted-foreground")}>
                  {formatRate(r)}
                  {r.rate !== null && r.lowSample && <span className="block text-[10px] leading-none">参考</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {limit && rows.length > limit && (
        <button type="button" className="mt-1 min-h-8 text-xs text-info underline" onClick={() => setAll((v) => !v)}>
          {all ? "上位だけ表示" : `すべて表示（${rows.length}件）`}
        </button>
      )}
    </section>
  );
}

/**
 * 応募実績・当選率。過去の応募と当落から実際の当選率を集計する（次回の当選確率の予測は Stage 6）。
 * 当落が確定した応募だけを母数にし、未確認・中止は別に数える。複数商品の抽選は応募単位と商品単位を分けて示す。
 */
export function RecordsView() {
  const { data } = useApp();
  const [period, setPeriod] = useState<Period>({ kind: "all", value: "" });
  const [profileId, setProfileId] = useState("all");
  const stats = useMemo(() => computeWinStats(data, { period, profileId }), [data, period, profileId]);
  const o = stats.overall;
  const hasMulti = stats.multiApplicationLevel.applied > 0;
  const profiles = data.profiles.filter((p) => p.active !== false);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-base font-bold">応募実績・当選率</h1>
        <Link href="/lotteries" className="text-xs text-info underline underline-offset-2">
          抽選管理へ
        </Link>
      </div>

      <div className="flex items-center gap-1.5">
        <div role="tablist" aria-label="期間の単位" className="grid shrink-0 grid-cols-3 rounded-lg bg-muted p-0.5">
          {KINDS.map((k) => (
            <button
              key={k.value}
              role="tab"
              type="button"
              aria-selected={period.kind === k.value}
              onClick={() =>
                setPeriod(k.value === "month" ? { kind: "month", value: jstDateString(new Date()).slice(0, 7) } : k.value === "year" ? { kind: "year", value: jstDateString(new Date()).slice(0, 4) } : { kind: "all", value: "" })
              }
              className={cn("min-h-9 rounded-md px-3 text-xs font-medium", period.kind === k.value ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-card")}
            >
              {k.label}
            </button>
          ))}
        </div>
        {period.kind !== "all" && (
          <div className="flex min-w-0 flex-1 items-center justify-between rounded-lg bg-card px-0.5">
            <Button variant="ghost" size="icon" className="size-9" aria-label="前の期間" onClick={() => setPeriod(shiftPeriod(period, -1))}>
              <ChevronLeft className="size-5" />
            </Button>
            <span className="text-sm font-semibold" data-testid="period-label">
              {periodLabel(period)}
            </span>
            <Button variant="ghost" size="icon" className="size-9" aria-label="次の期間" onClick={() => setPeriod(shiftPeriod(period, 1))}>
              <ChevronRight className="size-5" />
            </Button>
          </div>
        )}
      </div>

      <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label="対象ユーザー">
        {[{ id: "all", label: "家族全体" }, ...profiles.map((p) => ({ id: p.id, label: p.label }))].map((p) => (
          <button key={p.id} type="button" aria-pressed={profileId === p.id} onClick={() => setProfileId(p.id)} className={cn("h-9 shrink-0 rounded-full border px-3 text-xs", profileId === p.id ? "border-primary bg-primary text-primary-foreground" : "bg-input")}>
            {p.label}
          </button>
        ))}
      </div>

      <section aria-label="全体" className="rounded-xl border bg-card p-3 shadow-card" data-testid="win-overall">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-[11px] text-muted-foreground">当選率（当落が確定した応募）</p>
            <p className="text-2xl font-extrabold tabular-nums" data-testid="win-rate">
              {formatRate(o)}
            </p>
            <p className="text-xs text-muted-foreground">
              {o.won}当選 / {o.decided}確定
              {o.rate !== null && o.lowSample && `（確定${MIN_SAMPLE}件未満のため参考値）`}
            </p>
          </div>
          <dl className="grid grid-cols-4 gap-x-3 text-center text-xs">
            {(
              [
                ["応募", o.applied],
                ["当選", o.won],
                ["落選", o.lost],
                ["未確認", o.pending],
              ] as const
            ).map(([l, n]) => (
              <div key={l}>
                <dt className="whitespace-nowrap text-[10px] text-muted-foreground">{l}</dt>
                <dd className="text-base font-bold tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
        </div>
        {o.cancelled > 0 && <p className="mt-1 text-xs text-muted-foreground">中止になった抽選が{o.cancelled}件あります（当選率には含めていません）。</p>}
        <p className="mt-1 text-[11px] text-muted-foreground">
          未確認は当落が未登録の応募で、当選率の母数に入れていません。応募・当落はこれまでの記録の集計で、次回の当選を予測するものではありません。
        </p>
      </section>

      {hasMulti && (
        <section aria-label="複数商品の抽選" className="rounded-xl border bg-card p-3 shadow-card" data-testid="win-multi">
          <h2 className="mb-1 text-sm font-bold">複数商品の抽選（応募単位と商品単位）</h2>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">応募単位（1回の応募を1件）</dt>
              <dd className="font-bold tabular-nums">
                {stats.multiApplicationLevel.won}当選 / {stats.multiApplicationLevel.decided}確定（{formatRate(stats.multiApplicationLevel)}）
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">商品単位（商品ごとの当落）</dt>
              <dd className="font-bold tabular-nums">
                {stats.multiItemLevel.won}当選 / {stats.multiItemLevel.decided}確定（{formatRate(stats.multiItemLevel)}）
              </dd>
            </div>
          </dl>
          <p className="mt-1 text-[11px] text-muted-foreground">1回の応募で複数の商品が当選しても、応募単位では1件として数えます。</p>
        </section>
      )}

      {profileId === "all" && <RateTable title="ユーザー別" labelHead="ユーザー" rows={stats.byProfile} testId="win-by-profile" />}
      <RateTable title="系列別" labelHead="系列" rows={stats.byChain} testId="win-by-chain" />
      <RateTable title="店舗別" labelHead="店舗" rows={stats.byStore} testId="win-by-store" limit={8} />
      <RateTable title="商品別（商品単位）" labelHead="商品" rows={stats.byProduct} testId="win-by-product" limit={8} />

      <p className="text-xs text-muted-foreground">
        購入履歴・収支は <Link href="/purchases" className="underline underline-offset-2">購入記録</Link>・<Link href="/finance" className="underline underline-offset-2">収支</Link> ページにあります。期間は抽選の応募締切日で判定します。
      </p>
    </div>
  );
}
