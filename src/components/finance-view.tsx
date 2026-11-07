"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChartColumn, ChevronLeft, ChevronRight, ListFilter } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ExpenseDialog } from "@/components/expense-dialog";
import { PAGE_HEADING_ROW, PageHeading } from "@/components/page-heading";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ExpenseBar } from "@/components/expense-bar";
import { LedgerDetailSheet } from "@/components/ledger-detail-sheet";
import { ProfileAvatar } from "@/components/profile-avatar";
import { SaleDialog } from "@/components/sale-dialog";
import { Button } from "@/components/ui/button";
import { jstDateString } from "@/lib/datetime";
import { categoryOf, EXPENSE_CATEGORIES } from "@/lib/expense-category";
import { ALL_PERIOD, ledgerEntries, monthSummary, shiftMonth, type LedgerFilter } from "@/lib/finance";
import { cn } from "@/lib/utils";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
/** 一覧カードの日付（今年は M/D、ほかの年は YY/M/D）。日付不明はそのまま */
function shortDate(date: string | null, today: string): string {
  if (!date) return "日付不明";
  const [y, m, d] = date.split("-").map(Number);
  return String(y) === today.slice(0, 4) ? `${m}/${d}` : `${String(y).slice(2)}/${m}/${d}`;
}

const PAGE = 60;

const TABS: { value: LedgerFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "expense", label: "支出" },
  { value: "income", label: "収入" },
];

/** 年月の選択（年を移動して月を選ぶ。購入記録の期間選択と同じ操作）。選んだ月へ直接移動する */
function MonthPicker({ ym, onPick, onClose }: { ym: string; onPick: (v: string) => void; onClose: () => void }) {
  const [year, setYear] = useState(ym === ALL_PERIOD ? new Date().getFullYear() : Number(ym.slice(0, 4)));
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent data-testid="month-picker">
        <DialogTitle>年月を選択</DialogTitle>
        <DialogDescription className="sr-only">月を選ぶと、その月の収支へ移動します</DialogDescription>
        <div className="mt-3 space-y-2">
          <button type="button" onClick={() => onPick(ALL_PERIOD)} aria-pressed={ym === ALL_PERIOD} data-testid="period-all" className={cn("min-h-10 w-full rounded-md border text-sm", ym === ALL_PERIOD ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
            全期間
          </button>
          <div className="flex items-center justify-between">
            <Button variant="ghost" size="icon" className="size-9" aria-label="前の年" onClick={() => setYear(year - 1)}>
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-sm font-semibold">{year}年</span>
            <Button variant="ghost" size="icon" className="size-9" aria-label="次の年" onClick={() => setYear(year + 1)}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
              const v = `${year}-${String(m).padStart(2, "0")}`;
              return (
                <button key={m} type="button" onClick={() => onPick(v)} aria-pressed={v === ym} className={cn("min-h-10 rounded-md border text-sm", v === ym ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
                  {m}月
                </button>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 絞り込み（品目・売却名義人）。選ぶとすぐ一覧へ反映され、「クリア」で全件に戻す */
function FinanceFilterDialog({ income, category, seller, sellers, onCategory, onSeller, onClose }: { income: boolean; category: string; seller: string; sellers: { id: string; label: string }[]; onCategory: (v: string) => void; onSeller: (v: string) => void; onClose: () => void }) {
  const options = income ? [{ id: "all", label: "全員" }, ...sellers] : [{ id: "all", label: "全品目" }, ...EXPENSE_CATEGORIES.map((c) => ({ id: c.id, label: c.label }))];
  const value = income ? seller : category;
  const set = income ? onSeller : onCategory;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent data-testid="finance-filter">
        <DialogTitle>絞り込み</DialogTitle>
        <DialogDescription className="sr-only">品目または売却名義人で一覧を絞り込みます</DialogDescription>
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{income ? "売却名義人" : "品目"}</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={income ? "売却名義人で絞り込み" : "品目で絞り込み"} data-testid="category-filter">
            {options.map((o) => (
              <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => set(o.id)} data-testid={`cat-${o.id}`} className={cn("h-9 rounded-full border px-3 text-xs", value === o.id ? "border-primary bg-primary text-primary-foreground" : "bg-input")}>
                {o.label}
              </button>
            ))}
          </div>
          <div className="flex justify-between gap-2 pt-2">
            <Button variant="outline" size="sm" disabled={value === "all"} onClick={() => set("all")} data-testid="finance-filter-clear">
              クリア
            </Button>
            <Button size="sm" onClick={onClose} data-testid="finance-filter-done">
              閉じる
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 収支管理。初期表示は当月。支出は購入記録、収入は売却記録から作られるため、抽選の購入済みや購入実績と同じデータを見ている
 * （収支明細と購入実績を別々に持たないので二重計上されない）。
 */
export function FinanceView() {
  const { data, persistent } = useApp();
  const [ym, setYm] = useState(() => jstDateString(new Date()).slice(0, 7));
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const [seller, setSeller] = useState<string>("all");
  const [category, setCategory] = useState<string>("all");
  const [expense, setExpense] = useState<{ id: string | null } | null>(null);
  const [sale, setSale] = useState<{ id: string | null } | null>(null);
  const [picking, setPicking] = useState(false);
  /** 取引の詳細（下から開くシート）。「編集」で入力フォームへ */
  const [detail, setDetail] = useState<{ kind: "expense" | "income"; id: string } | null>(null);
  const [filtering, setFiltering] = useState(false);
  // 適用中の絞り込み: 支出/すべては品目、収入は売却名義人
  const activeFilters = (filter === "income" ? (seller !== "all" ? 1 : 0) : category !== "all" ? 1 : 0);

  const summary = useMemo(() => monthSummary(data, ym), [data, ym]);
  const entries = useMemo(() => ledgerEntries(data, ym, filter, filter === "income" ? seller : "all", filter === "income" ? "all" : category), [data, ym, filter, seller, category]);
  const all = ym === ALL_PERIOD;
  const today = jstDateString(new Date());
  // 全期間でも軽く動くよう、60件ずつ描画する（末尾が近づくと続きを読み込む）。期間・種類・絞り込みを変えたら先頭から
  const [limit, setLimit] = useState(PAGE);
  const listKey = `${ym}|${filter}|${seller}|${category}`;
  const [lastKey, setLastKey] = useState(listKey);
  if (lastKey !== listKey) {
    setLastKey(listKey);
    setLimit(PAGE);
  }
  const visible = entries.slice(0, limit);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || visible.length >= entries.length) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setLimit((n) => n + PAGE), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible.length, entries.length]);
  const bar = summary.byCategory.map((c) => ({ id: c.category, label: categoryOf(c.category).short, amount: c.amount, color: categoryOf(c.category).color }));
  const [y, mo] = all ? ["", ""] : ym.split("-");

  return (
    <div className="space-y-2">
      <div className={PAGE_HEADING_ROW}>
        <PageHeading navId="finance">収支</PageHeading>
        <div className="flex items-center gap-1.5">
          <Link href="/finance/analysis" aria-label="年間売却実績・収益分析" data-testid="to-analysis" className="flex size-9 items-center justify-center rounded-md hover:bg-muted">
            <ChartColumn className="size-[18px]" aria-hidden="true" />
          </Link>
          {persistent && (
            <>
              <Button size="sm" onClick={() => setExpense({ id: null })}>
                ＋支出
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSale({ id: null })}>
                ＋売却
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg bg-card px-1 py-0.5">
        <Button variant="ghost" size="icon" className="size-10" aria-label="前の月" disabled={all} onClick={() => setYm(shiftMonth(ym, -1))}>
          <ChevronLeft className="size-5" />
        </Button>
        <button type="button" onClick={() => setPicking(true)} aria-label="年月を選ぶ" data-testid="month-label" className="min-h-10 rounded-md px-3 text-sm font-semibold hover:bg-muted">
          {all ? "全期間" : `${y}年${Number(mo)}月`}
        </button>
        <Button variant="ghost" size="icon" className="size-10" aria-label="次の月" disabled={all} onClick={() => setYm(shiftMonth(ym, 1))}>
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

      <div className="flex items-center gap-1.5">
        <div role="tablist" aria-label="収支の種類" className="grid min-w-0 flex-1 grid-cols-3 rounded-lg bg-muted p-0.5">
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
        <button
          type="button"
          onClick={() => setFiltering(true)}
          aria-label={activeFilters > 0 ? `絞り込み（${activeFilters}件適用中）` : "絞り込み"}
          data-testid="finance-filter-open"
          data-active={activeFilters > 0 ? "1" : "0"}
          className={cn("relative flex size-11 shrink-0 items-center justify-center rounded-lg border", activeFilters > 0 ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}
        >
          <ListFilter className="size-[18px]" aria-hidden="true" />
          {activeFilters > 0 && <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-foreground text-[10px] font-bold text-background">{activeFilters}</span>}
        </button>
      </div>

      {filter !== "income" && <ExpenseBar items={bar} />}

      {/* 取引1件につき独立した角丸カード（日付ごとの見出し・区切りは無い）。左端の細いラインと分類名で支出の分類を示す。系列・店舗は詳細で確認 */}
      <ul className="space-y-1.5" data-testid="ledger-list" aria-label="取引一覧">
        {visible.map((e) => {
          const seller = e.sellerProfileId ? data.profiles.find((p) => p.id === e.sellerProfileId) : undefined;
          const cat = e.kind === "expense" ? categoryOf(e.category) : null;
          const color = cat ? cat.color : "var(--info)";
          return (
            <li key={`${e.kind}-${e.id}`}>
              <button
                type="button"
                onClick={() => setDetail({ kind: e.kind, id: e.id })}
                className="relative flex w-full flex-col gap-0.5 overflow-hidden rounded-xl border bg-card py-1.5 pl-3.5 pr-3 text-left active:bg-muted/60"
                data-testid="ledger-row"
                data-kind={e.kind}
                data-category={e.category ?? ""}
              >
                <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1" style={{ background: color }} data-testid="row-line" />
                <span className="flex items-center gap-1.5 text-xs">
                  <span className="tabular-nums text-muted-foreground" data-testid="row-date">
                    {shortDate(e.date, today)}
                  </span>
                  <span className="shrink-0 rounded-full border px-1.5 text-[10px] font-medium leading-4" style={{ color, borderColor: color }} data-testid="row-category">
                    {cat ? cat.short : "売却"}
                  </span>
                  {seller && <ProfileAvatar profile={seller} size="xs" />}
                  <span className={cn("ml-auto shrink-0 text-sm font-semibold tabular-nums", e.kind === "income" && "text-info")}>
                    {e.amount === null ? <span className="text-xs font-normal text-muted-foreground">金額未入力</span> : `${e.kind === "income" ? "+" : "-"}${yen(e.amount)}`}
                  </span>
                </span>
                <span className="block truncate text-sm" title={e.title} data-testid="row-title">
                  {e.title}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div ref={sentinel} aria-hidden="true" />
      {visible.length < entries.length && (
        <Button variant="outline" className="w-full" onClick={() => setLimit((n) => n + PAGE)} data-testid="ledger-more">
          もっと見る（{visible.length}/{entries.length}）
        </Button>
      )}
      {entries.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{all ? "取引はありません。" : "この月の取引はありません。"}</p>}

      {filtering && (
        <FinanceFilterDialog
          income={filter === "income"}
          category={category}
          seller={seller}
          sellers={data.profiles.filter((p) => p.active !== false).map((p) => ({ id: p.id, label: p.label }))}
          onCategory={setCategory}
          onSeller={setSeller}
          onClose={() => setFiltering(false)}
        />
      )}
      {picking && <MonthPicker ym={ym} onPick={(v) => { setYm(v); setPicking(false); }} onClose={() => setPicking(false)} />}
      {detail && (
        <LedgerDetailSheet
          kind={detail.kind}
          id={detail.id}
          onClose={() => setDetail(null)}
          onEdit={() => {
            const d = detail;
            setDetail(null);
            if (d.kind === "expense") setExpense({ id: d.id });
            else setSale({ id: d.id });
          }}
        />
      )}
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
