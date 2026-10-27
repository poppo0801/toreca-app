"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ExpenseDialog } from "@/components/expense-dialog";
import { ProfileAvatar } from "@/components/profile-avatar";
import { SaleDialog } from "@/components/sale-dialog";
import { Button } from "@/components/ui/button";
import { jstDateString } from "@/lib/datetime";
import { ledgerEntries, monthSummary, shiftMonth, type LedgerFilter } from "@/lib/finance";
import { cn } from "@/lib/utils";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

function dayLabel(date: string | null): string {
  if (!date) return "日付不明";
  const [y, m, d] = date.split("-").map(Number);
  return `${m}/${d}（${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

const TABS: { value: LedgerFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "expense", label: "支出" },
  { value: "income", label: "収入" },
];

/**
 * 収支管理。初期表示は当月。支出は購入記録、収入は売却記録から作られるため、抽選の購入済みや購入実績と同じデータを見ている
 * （収支明細と購入実績を別々に持たないので二重計上されない）。
 */
export function FinanceView() {
  const { data, persistent } = useApp();
  const [ym, setYm] = useState(() => jstDateString(new Date()).slice(0, 7));
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const [seller, setSeller] = useState<string>("all");
  const [expense, setExpense] = useState<{ id: string | null } | null>(null);
  const [sale, setSale] = useState<{ id: string | null } | null>(null);

  const summary = useMemo(() => monthSummary(data, ym), [data, ym]);
  const entries = useMemo(() => ledgerEntries(data, ym, filter, filter === "income" ? seller : "all"), [data, ym, filter, seller]);
  const groups = useMemo(() => {
    const m = new Map<string, typeof entries>();
    for (const e of entries) m.set(e.date ?? "", [...(m.get(e.date ?? "") ?? []), e]);
    return [...m.entries()];
  }, [entries]);
  const [y, mo] = ym.split("-");

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-base font-bold">収支</h1>
        {persistent && (
          <div className="flex gap-1.5">
            <Button size="sm" onClick={() => setExpense({ id: null })}>
              ＋支出
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSale({ id: null })}>
              ＋売却
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between rounded-lg bg-card px-1 py-0.5">
        <Button variant="ghost" size="icon" className="size-10" aria-label="前の月" onClick={() => setYm(shiftMonth(ym, -1))}>
          <ChevronLeft className="size-5" />
        </Button>
        <span className="text-sm font-semibold" data-testid="month-label">
          {y}年{Number(mo)}月
        </span>
        <Button variant="ghost" size="icon" className="size-10" aria-label="次の月" onClick={() => setYm(shiftMonth(ym, 1))}>
          <ChevronRight className="size-5" />
        </Button>
      </div>

      <dl className="grid grid-cols-3 gap-1.5 text-center" data-testid="month-summary">
        <div className="rounded-lg bg-card p-2">
          <dt className="text-[11px] text-muted-foreground">支出</dt>
          <dd className="text-sm font-bold" data-testid="sum-expense">{yen(summary.expense)}</dd>
        </div>
        <div className="rounded-lg bg-card p-2">
          <dt className="text-[11px] text-muted-foreground">収入</dt>
          <dd className="text-sm font-bold text-info" data-testid="sum-income">{yen(summary.income)}</dd>
        </div>
        <div className="rounded-lg bg-card p-2">
          <dt className="text-[11px] text-muted-foreground">収支</dt>
          <dd className={cn("text-sm font-bold", summary.net < 0 && "text-danger")} data-testid="sum-net">
            {summary.net < 0 ? "-" : ""}
            {yen(Math.abs(summary.net))}
          </dd>
        </div>
      </dl>
      {summary.expenseUnknown > 0 && (
        <p className="text-xs text-muted-foreground">金額が未入力の購入が{summary.expenseUnknown}件あります（支出には含まれていません）。</p>
      )}

      <div role="tablist" aria-label="収支の種類" className="grid grid-cols-3 rounded-lg bg-muted p-0.5">
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            type="button"
            aria-selected={filter === t.value}
            onClick={() => setFilter(t.value)}
            className={cn("min-h-10 rounded-md text-[13px] font-medium", filter === t.value ? "bg-primary text-primary-foreground" : "hover:bg-card")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {filter === "income" && (
        <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label="売却名義人で絞り込み">
          {[{ id: "all", label: "全員" }, ...data.profiles.filter((p) => p.active !== false).map((p) => ({ id: p.id, label: p.label }))].map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={seller === o.id}
              onClick={() => setSeller(o.id)}
              className={cn("h-9 shrink-0 rounded-full border px-3 text-xs", seller === o.id ? "border-primary bg-primary text-primary-foreground" : "bg-input")}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      <ul className="space-y-2" data-testid="ledger-list" aria-label="取引一覧">
        {groups.map(([date, list]) => (
          <li key={date || "none"}>
            <p className="mb-0.5 px-1 text-xs text-muted-foreground">{dayLabel(date || null)}</p>
            <ul className="divide-y overflow-hidden rounded-lg border bg-card">
              {list.map((e) => {
                const seller = e.sellerProfileId ? data.profiles.find((p) => p.id === e.sellerProfileId) : undefined;
                return (
                  <li key={`${e.kind}-${e.id}`}>
                    <button
                      type="button"
                      disabled={!persistent}
                      onClick={() => (e.kind === "expense" ? setExpense({ id: e.id }) : setSale({ id: e.id }))}
                      className="flex min-h-14 w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted disabled:hover:bg-transparent"
                      data-testid="ledger-row"
                      data-kind={e.kind}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{e.title}</span>
                        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          {seller && <ProfileAvatar profile={seller} size="xs" />}
                          {e.sub}
                        </span>
                      </span>
                      <span className={cn("shrink-0 text-sm font-semibold", e.kind === "income" ? "text-info" : "")}>
                        {e.amount === null ? <span className="text-xs font-normal text-muted-foreground">金額未入力</span> : `${e.kind === "income" ? "+" : "-"}${yen(e.amount)}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {entries.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">この月の取引はありません。</p>}

      <nav aria-label="関連ページ" className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-sm">
        <Link href="/finance/analysis" className="underline underline-offset-2">
          年間売却実績・収益分析
        </Link>
        <Link href="/records" className="underline underline-offset-2">
          応募・当選実績
        </Link>
      </nav>

      {expense && (
        <ExpenseDialog
          key={expense.id ?? "new"}
          open
          onOpenChange={(v) => !v && setExpense(null)}
          purchase={expense.id ? (data.purchases.find((p) => p.id === expense.id) ?? null) : null}
        />
      )}
      {sale && <SaleDialog key={sale.id ?? "new"} open onOpenChange={(v) => !v && setSale(null)} sale={sale.id ? (data.sales.find((s) => s.id === sale.id) ?? null) : null} />}
    </div>
  );
}
