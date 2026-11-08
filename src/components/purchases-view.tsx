"use client";

import { PAGE_HEADING_ROW, PageHeading } from "@/components/page-heading";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/components/app-provider";
import { ExpenseDialog } from "@/components/expense-dialog";
import { PurchaseThumb } from "@/components/product-image";
import { Button } from "@/components/ui/button";
import { jstDateString } from "@/lib/datetime";
import { productName, purchaseStoreName, purchaseTotal } from "@/lib/finance";
import { flexToJstDate } from "@/lib/finance";
import { filterPurchases, isSingleItem, periodLabel, productTotals, purchaseStats, quantityLabel, shiftPeriod, type Period, type PeriodKind, type ProductTotal } from "@/lib/purchase-records";
import { cn } from "@/lib/utils";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const CHANNEL = { store: "店頭", shipping: "発送", online: "オンライン", other: "その他" } as const;
const KINDS: { value: PeriodKind; label: string }[] = [
  { value: "month", label: "月" },
  { value: "year", label: "年" },
  { value: "all", label: "全期間" },
];

/** 購入日の表示（購入履歴の各カードの中。日付見出しは出さない） */
function dayLabel(date: string | null): string {
  if (!date) return "日付不明";
  const [y, m, d] = date.split("-").map(Number);
  return `${m}/${d}（${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

const chip = "h-9 min-w-0 shrink rounded-full border bg-input px-3 text-xs";

/** 商品別累計の1行の表示内容。数量を主役にし、金額は補足にする（Stage 7E） */
export function totalDisplay(r: ProductTotal): { qty: string; sub: string } {
  const boxes = r.direct.box ?? 0;
  const packs = r.direct.pack ?? 0;
  const sets = (r.direct.set ?? 0) + (r.direct.piece ?? 0);
  const amount = r.amount > 0 || r.amountUnknown === 0 ? `購入総額 ${yen(r.amount)}` : "金額未入力";
  if (r.single) return { qty: `${sets}枚`, sub: amount };
  if (boxes + packs > 0) {
    // BOX・パック: 累計パック数を主役に（入数が不明なBOXがあるときは換算せず、BOX数を主役にする）
    const parts: string[] = [];
    if (r.packEquivalent !== null) {
      if (boxes > 0) parts.push(`${boxes}BOX`);
      if (packs > 0 && boxes > 0) parts.push(`単品${packs}パック`);
      if (sets > 0) parts.push(`${sets}個`);
      parts.push(amount);
      return { qty: `${r.packEquivalent}パック`, sub: parts.join(" ｜ ") };
    }
    if (packs > 0) parts.push(`${packs}パック`);
    if (sets > 0) parts.push(`${sets}個`);
    parts.push(amount);
    return { qty: `${boxes}BOX`, sub: parts.join(" ｜ ") };
  }
  return { qty: `${sets}個`, sub: amount };
}

/**
 * 購入記録（何を・どれだけ・いつ・どこで）。収支の支出と同じデータを見ているので、収支で登録した支出も、
 * 抽選で「購入済み」にした当選も、ここから登録した購入も、同じ一覧に出て、編集・削除はどこからでも反映される。
 * 家族共通の記録で、プロフィール別には分けない。金額よりも購入数量を優先して表示する（Stage 7E）。
 */
export function PurchasesView() {
  const { data, persistent } = useApp();
  const [period, setPeriod] = useState<Period>(() => ({ kind: "month", value: jstDateString(new Date()).slice(0, 7) }));
  const [productId, setProductId] = useState("");
  const [storeId, setStoreId] = useState("");
  // 初期表示は「商品別の累計」（左）。右が購入履歴
  const [tab, setTab] = useState<"products" | "history">("products");
  const [edit, setEdit] = useState<{ id: string | null } | null>(null);

  const purchases = useMemo(() => filterPurchases(data, { period, productId, storeId }), [data, period, productId, storeId]);
  const stats = useMemo(() => purchaseStats(data, purchases), [data, purchases]);
  const totals = useMemo(() => productTotals(data, purchases, productId), [data, purchases, productId]);

  const boughtProducts = useMemo(() => {
    const ids = new Set(data.purchases.flatMap((p) => p.items.map((i) => i.productId).filter(Boolean) as string[]));
    return data.products.filter((p) => ids.has(p.id));
  }, [data]);
  const boughtStores = useMemo(() => {
    const ids = new Set(data.purchases.map((p) => p.storeId).filter(Boolean) as string[]);
    return data.stores.filter((s) => ids.has(s.id));
  }, [data]);
  const hasFilter = productId !== "" || storeId !== "";
  const [picker, setPicker] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  // 選べる年: 購入データのある年と今年（新しい順）
  const dataYears = useMemo(() => {
    const ys = new Set<number>([Number(jstDateString(new Date()).slice(0, 4))]);
    for (const pu of data.purchases) {
      const d = flexToJstDate(pu.purchasedOn);
      if (d) ys.add(Number(d.slice(0, 4)));
    }
    return [...ys].sort((x, y) => y - x);
  }, [data.purchases]);

  const cells: { id: string; label: string; value: string; note?: string }[] = [
    { id: "box", label: "BOX", value: String(stats.box) },
    { id: "pack", label: "パック", value: String(stats.pack), note: stats.packUnknownBoxes > 0 ? `入数が未設定のBOX ${stats.packUnknownBoxes}個はパックに換算していません` : undefined },
    { id: "other", label: "その他商品", value: String(stats.other) },
    { id: "amount", label: "総額", value: `¥${stats.amount.toLocaleString("ja-JP")}` },
  ];

  return (
    <div className="space-y-2">
      <div className={PAGE_HEADING_ROW}>
        <PageHeading navId="purchases">購入記録</PageHeading>
        {persistent && (
          <Button size="sm" onClick={() => setEdit({ id: null })}>
            ＋購入を記録
          </Button>
        )}
      </div>

      {/* 1. 期間選択（〈 2026年11月 〉）と、右側の小さな絞り込みボタン */}
      <div className="flex items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center justify-between rounded-lg bg-card px-0.5">
          <Button variant="ghost" size="icon" className="size-10" aria-label="前の期間" disabled={period.kind === "all"} onClick={() => setPeriod(shiftPeriod(period, -1))}>
            <ChevronLeft className="size-5" />
          </Button>
          <button type="button" onClick={() => setPicker(true)} aria-haspopup="dialog" className="min-h-10 flex-1 rounded-md text-sm font-semibold hover:bg-muted" data-testid="period-label">
            {periodLabel(period)}
          </button>
          <Button variant="ghost" size="icon" className="size-10" aria-label="次の期間" disabled={period.kind === "all"} onClick={() => setPeriod(shiftPeriod(period, 1))}>
            <ChevronRight className="size-5" />
          </Button>
        </div>
        <Button variant="outline" size="icon" className={cn("relative size-10 shrink-0", hasFilter && "border-primary text-primary-ink")} aria-label={hasFilter ? "絞り込み（設定中）" : "絞り込み"} aria-expanded={showFilter || hasFilter} onClick={() => setShowFilter((v) => !v)} data-testid="filter-toggle">
          <SlidersHorizontal className="size-4" aria-hidden="true" />
          {hasFilter && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-primary" aria-hidden="true" />}
        </Button>
      </div>
      <PeriodPicker open={picker} onOpenChange={setPicker} period={period} onPick={(p) => (setPeriod(p), setPicker(false))} years={dataYears} />

      {(showFilter || hasFilter) && (
        <div className="flex gap-1.5" data-testid="purchase-filters">
          <select aria-label="商品で絞り込み" value={productId} onChange={(e) => setProductId(e.target.value)} className={cn(chip, "flex-1")}>
            <option value="">商品: すべて</option>
            {boughtProducts.map((pr) => (
              <option key={pr.id} value={pr.id}>
                {pr.officialName}
              </option>
            ))}
          </select>
          <select aria-label="店舗で絞り込み" value={storeId} onChange={(e) => setStoreId(e.target.value)} className={cn(chip, "flex-1")}>
            <option value="">店舗: すべて</option>
            {boughtStores.map((st) => (
              <option key={st.id} value={st.id}>
                {data.chains.find((c) => c.id === st.chainId)?.name} {st.name}
              </option>
            ))}
          </select>
          {hasFilter && (
            <button type="button" className={cn(chip, "shrink-0 text-primary-ink")} onClick={() => (setProductId(""), setStoreId(""))}>
              解除
            </button>
          )}
        </div>
      )}

      {/* 2. 商品別の累計（左）／購入履歴（右）の切替 */}
      <div role="tablist" aria-label="表示の切替" className="grid grid-cols-2 rounded-lg bg-muted p-0.5">
        {(
          [
            ["products", "商品別の累計"],
            ["history", "購入履歴"],
          ] as const
        ).map(([v, label]) => (
          <button key={v} role="tab" type="button" aria-selected={tab === v} onClick={() => setTab(v)} className={cn("min-h-9 rounded-md text-[13px] font-medium", tab === v ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-card")} data-testid={`tab-${v}`}>
            {label}
          </button>
        ))}
      </div>

      {/* 3. 集計（BOX・パック・その他商品・総額）を横4分割の1行で */}
      <dl className="grid grid-cols-4 divide-x rounded-lg border bg-card py-1.5 text-center shadow-card" data-testid="purchase-summary">
        {cells.map((c) => (
          <div key={c.id} className="min-w-0 px-1" data-testid={`stat-${c.id}`} title={c.note}>
            <dt className="truncate text-[10px] leading-4 text-muted-foreground">{c.label}</dt>
            <dd className={cn("truncate font-bold tabular-nums leading-5", c.value.length >= 9 ? "text-xs" : "text-sm")}>
              {c.value}
              {c.note && (
                <span aria-label={c.note} className="text-[10px] font-normal text-muted-foreground">
                  ＊
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {stats.amountUnknown > 0 && <p className="text-xs text-muted-foreground">金額が未入力の購入が{stats.amountUnknown}件あります（総額には含まれていません。0円とは扱いません）。</p>}

      {/* 4. 一覧 */}
      {tab === "history" ? (
        <ul className="space-y-2" data-testid="purchase-list" aria-label="購入履歴">
          {purchases.map((p) => {
            const first = p.items[0];
            const product = first?.productId ? data.products.find((x) => x.id === first.productId) : undefined;
            const t = purchaseTotal(p);
            const date = flexToJstDate(p.purchasedOn);
            const kind = first && isSingleItem(p, first) ? "single_card" : p.category;
            const store = purchaseStoreName(data, p);
            return (
              <li key={p.id}>
                <button type="button" disabled={!persistent} onClick={() => setEdit({ id: p.id })} data-testid="purchase-row" className="flex min-h-16 w-full items-center gap-2.5 rounded-xl border bg-card px-2.5 py-2 text-left shadow-card hover:bg-muted disabled:hover:bg-card">
                  <span className="flex h-12 w-10 shrink-0 items-center justify-center">
                    <PurchaseThumb product={product} category={kind} heightClass="h-12" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" data-testid="purchase-title">
                      {first ? productName(data, first.productId, first.productLabel) : "購入"}
                      {p.items.length > 1 && <span className="text-muted-foreground"> ほか{p.items.length - 1}件</span>}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs">
                      <span className="font-semibold" data-testid="purchase-qty">
                        {p.items.map((i) => quantityLabel(i, p.category)).join(" / ")}
                      </span>
                      <span className="tabular-nums text-muted-foreground" data-testid="purchase-date">
                        {dayLabel(date)}
                      </span>
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {store}
                      {store ? " ・ " : ""}
                      {CHANNEL[p.channel]}
                      {p.source === "lottery" && <span className="ml-1.5 rounded border border-info px-1 text-[10px] text-info">抽選当選</span>}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-sm font-semibold tabular-nums" data-testid="purchase-amount">
                    {t.unknown === p.items.length ? <span className="text-xs font-normal text-muted-foreground">金額未入力</span> : yen(t.total)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card" data-testid="product-totals" aria-label="商品別の累計">
          {totals.map((r) => {
            const product = r.productId ? data.products.find((x) => x.id === r.productId) : undefined;
            const d = totalDisplay(r);
            return (
              <li key={r.productId ?? r.label} className="flex items-center gap-2.5 px-2.5 py-2" data-testid="product-total-row">
                <span className="flex h-14 w-11 shrink-0 items-center justify-center">
                  <PurchaseThumb product={product} category={r.single ? "single_card" : r.category} heightClass="h-14" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" data-testid="total-name">
                    {r.label}
                  </span>
                  <span className="block text-lg font-bold leading-6 tabular-nums" data-testid="total-qty">
                    {d.qty}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground" data-testid="total-sub">
                    {d.sub}
                  </span>
                </span>
              </li>
            );
          })}
          {totals.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">該当する購入はありません。</li>}
        </ul>
      )}
      {tab === "history" && purchases.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">この条件の購入記録はありません。</p>}

      {edit && <ExpenseDialog key={edit.id ?? "new"} open onOpenChange={(v) => !v && setEdit(null)} purchase={edit.id ? (data.purchases.find((p) => p.id === edit.id) ?? null) : null} />}
    </div>
  );
}

/** 期間選択: 月単位（年を移動して月を選ぶ）・年単位・全期間 */
function PeriodPicker({ open, onOpenChange, period, onPick, years }: { open: boolean; onOpenChange: (v: boolean) => void; period: Period; onPick: (p: Period) => void; years: number[] }) {
  const thisYear = Number(jstDateString(new Date()).slice(0, 4));
  const [kind, setKind] = useState<PeriodKind>(period.kind);
  const [year, setYear] = useState(period.kind === "all" ? thisYear : Number(period.value.slice(0, 4)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="period-picker">
        <DialogTitle>期間を選択</DialogTitle>
        <DialogDescription className="sr-only">月・年・全期間から選びます</DialogDescription>
        <div role="tablist" aria-label="期間の単位" className="mt-3 grid grid-cols-3 rounded-lg bg-muted p-0.5">
          {KINDS.map((k) => (
            <button key={k.value} role="tab" type="button" aria-selected={kind === k.value} onClick={() => (k.value === "all" ? onPick({ kind: "all", value: "" }) : setKind(k.value))} className={cn("min-h-9 rounded-md text-xs font-medium", kind === k.value ? "bg-primary text-primary-foreground" : "hover:bg-card")}>
              {k.label}
            </button>
          ))}
        </div>
        {kind === "month" && (
          <div className="mt-3 space-y-2">
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
                  <button key={m} type="button" onClick={() => onPick({ kind: "month", value: v })} className={cn("min-h-10 rounded-md border text-sm", period.kind === "month" && period.value === v ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
                    {m}月
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {kind === "year" && (
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {years.map((y) => (
              <button key={y} type="button" onClick={() => onPick({ kind: "year", value: String(y) })} className={cn("min-h-10 rounded-md border text-sm", period.kind === "year" && period.value === String(y) ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
                {y}年
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
