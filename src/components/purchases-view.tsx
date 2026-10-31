"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/components/app-provider";
import { ExpenseDialog } from "@/components/expense-dialog";
import { ProductThumb } from "@/components/product-image";
import { Button } from "@/components/ui/button";
import { jstDateString } from "@/lib/datetime";
import { productName, purchaseStoreName, purchaseTotal, UNIT_LABEL } from "@/lib/finance";
import { flexToJstDate } from "@/lib/finance";
import { filterPurchases, periodLabel, productTotals, quantityLabel, shiftPeriod, summarize, type Period, type PeriodKind } from "@/lib/purchase-records";
import { cn } from "@/lib/utils";
import type { ItemUnit, Purchase } from "@/types/domain";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const CHANNEL = { store: "店頭", shipping: "発送", online: "オンライン", other: "その他" } as const;
const KINDS: { value: PeriodKind; label: string }[] = [
  { value: "month", label: "月" },
  { value: "year", label: "年" },
  { value: "all", label: "全期間" },
];

function dayLabel(date: string | null): string {
  if (!date) return "日付不明";
  const [y, m, d] = date.split("-").map(Number);
  return `${m}/${d}（${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

const chip = "h-9 min-w-0 shrink rounded-full border bg-input px-3 text-xs";

/**
 * 購入記録（いつ・どこで・何を・どれだけ）。収支の支出と同じデータを見ているので、収支で登録した支出も、
 * 抽選で「購入済み」にした当選も、ここから登録した購入も、同じ一覧に出て、編集・削除はどこからでも反映される。
 * 家族共通の記録で、プロフィール別には分けない。
 */
/** シングルカードの購入を、コレクションの登録画面へ引き継ぐリンク（購入記録・収支は変更しない。参照のみ） */
function collectionHref(p: Purchase, name: string, store: string): string {
  const it = p.items[0];
  const unit = it.amountPaid !== null && it.quantity > 0 && it.amountPaid % it.quantity === 0 ? it.amountPaid / it.quantity : null;
  const date = flexToJstDate(p.purchasedOn);
  const q = new URLSearchParams({ add: "1", name, qty: String(it.quantity), purchase: p.id, source: store });
  if (unit !== null) q.set("price", String(unit));
  if (date) q.set("date", date);
  return `/collection?${q.toString()}`;
}

export function PurchasesView() {
  const { data, persistent } = useApp();
  const [period, setPeriod] = useState<Period>(() => ({ kind: "month", value: jstDateString(new Date()).slice(0, 7) }));
  const [productId, setProductId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [tab, setTab] = useState<"history" | "products">("history");
  const [edit, setEdit] = useState<{ id: string | null } | null>(null);

  const purchases = useMemo(() => filterPurchases(data, { period, productId, storeId }), [data, period, productId, storeId]);
  const summary = useMemo(() => summarize(purchases), [purchases]);
  const totals = useMemo(() => productTotals(data, purchases, productId), [data, purchases, productId]);
  const groups = useMemo(() => {
    const m = new Map<string, typeof purchases>();
    for (const p of purchases) {
      const k = flexToJstDate(p.purchasedOn) ?? "";
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()];
  }, [purchases]);

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

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-base font-bold">購入記録</h1>
        {persistent && (
          <Button size="sm" onClick={() => setEdit({ id: null })}>
            ＋購入を記録
          </Button>
        )}
      </div>

      {/* 1. 期間選択: 〈 2026年10月 〉。年月をタップで月・年・全期間を選ぶ */}
      <div className="flex items-center justify-between rounded-lg bg-card px-0.5">
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
      <PeriodPicker open={picker} onOpenChange={setPicker} period={period} onPick={(p) => (setPeriod(p), setPicker(false))} years={dataYears} />

      {/* 2. 購入履歴／商品別の切替 */}
      <div role="tablist" aria-label="表示の切替" className="grid grid-cols-2 rounded-lg bg-muted p-0.5">
        {(
          [
            ["history", "購入履歴"],
            ["products", "商品別の累計"],
          ] as const
        ).map(([v, label]) => (
          <button key={v} role="tab" type="button" aria-selected={tab === v} onClick={() => setTab(v)} className={cn("min-h-9 rounded-md text-[13px] font-medium", tab === v ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-card")}>
            {label}
          </button>
        ))}
      </div>

      {/* 3. 購入件数・購入金額 */}
      <dl className="grid grid-cols-2 gap-1.5 text-center" data-testid="purchase-summary">
        <div className="rounded-lg border bg-card p-2 shadow-card">
          <dt className="text-[11px] text-muted-foreground">購入</dt>
          <dd className="text-sm font-bold" data-testid="purchase-count">
            {summary.count}件
          </dd>
        </div>
        <div className="rounded-lg border bg-card p-2 shadow-card">
          <dt className="text-[11px] text-muted-foreground">購入金額</dt>
          <dd className="text-sm font-bold" data-testid="purchase-amount">
            {yen(summary.amount)}
          </dd>
        </div>
      </dl>
      {summary.amountUnknown > 0 && <p className="text-xs text-muted-foreground">金額が未入力の購入が{summary.amountUnknown}件あります（購入金額には含まれていません。0円とは扱いません）。</p>}

      {/* 4. 商品・店舗の絞り込み（折りたたみ） */}
      <div>
        <button type="button" aria-expanded={showFilter || hasFilter} onClick={() => setShowFilter((v) => !v)} className={cn("flex min-h-9 items-center gap-1 rounded-full border bg-input px-3 text-xs", hasFilter && "border-primary text-primary-ink")} data-testid="filter-toggle">
          <SlidersHorizontal className="size-3.5" aria-hidden="true" /> 絞り込み{hasFilter && "（設定中）"}
        </button>
        {(showFilter || hasFilter) && (
          <div className="mt-1.5 flex gap-1.5" data-testid="purchase-filters">
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
      </div>

      {/* 5. 購入データ一覧 */}
      {tab === "history" ? (
        <ul className="space-y-2" data-testid="purchase-list" aria-label="購入履歴">
          {groups.map(([date, list]) => (
            <li key={date || "none"}>
              <p className="mb-0.5 px-1 text-xs text-muted-foreground">{dayLabel(date || null)}</p>
              <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
                {list.map((p) => {
                  const first = p.items[0];
                  const product = first?.productId ? data.products.find((x) => x.id === first.productId) : undefined;
                  const t = purchaseTotal(p);
                  return (
                    <li key={p.id}>
                      <button type="button" disabled={!persistent} onClick={() => setEdit({ id: p.id })} data-testid="purchase-row" className="flex min-h-16 w-full items-center gap-2.5 px-2.5 py-2 text-left hover:bg-muted disabled:hover:bg-transparent">
                        <span className="flex h-12 w-10 shrink-0 items-center justify-center">
                          <ProductThumb product={product} heightClass="h-12" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {first ? productName(data, first.productId, first.productLabel) : "購入"}
                            {p.items.length > 1 && <span className="text-muted-foreground"> ほか{p.items.length - 1}件</span>}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">{purchaseStoreName(data, p)}</span>
                          <span className="flex flex-wrap items-center gap-x-2 text-xs">
                            <span>{p.items.map(quantityLabel).join(" / ")}</span>
                            <span className="text-muted-foreground">{CHANNEL[p.channel]}</span>
                            {p.source === "lottery" && <span className="rounded border border-info px-1 text-[10px] text-info">抽選当選</span>}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold">
                          {t.unknown === p.items.length ? <span className="text-xs font-normal text-muted-foreground">金額未入力</span> : yen(t.total)}
                        </span>
                      </button>
                      {persistent && p.source === "manual" && p.items.length === 1 && (
                        <Link href={collectionHref(p, productName(data, first.productId, first.productLabel), purchaseStoreName(data, p))} data-testid="to-collection" className="block px-2.5 pb-1.5 text-right text-xs text-info underline">
                          コレクションに追加
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card" data-testid="product-totals" aria-label="商品別の累計">
          {totals.map((r) => {
            const product = r.productId ? data.products.find((x) => x.id === r.productId) : undefined;
            const units = (Object.keys(r.direct) as ItemUnit[]).map((u) => `${UNIT_LABEL[u]}×${r.direct[u]}`);
            return (
              <li key={r.productId ?? r.label} className="flex items-center gap-2.5 px-2.5 py-2" data-testid="product-total-row">
                <span className="flex h-12 w-10 shrink-0 items-center justify-center">
                  <ProductThumb product={product} heightClass="h-12" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.label}</span>
                  <span className="block text-xs">{units.length > 0 ? units.join(" / ") : "直接の購入なし"}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {r.packEquivalent !== null ? `パック換算 ${r.packEquivalent}P` : (r.direct.box ?? 0) > 0 ? "入数未設定のためパック換算なし" : ""}
                    {r.viaSet > 0 && `${r.packEquivalent !== null || (r.direct.box ?? 0) > 0 ? " ・ " : ""}セット購入に含まれる分 +${r.viaSet}（参考）`}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-semibold">{r.amount > 0 || r.amountUnknown === 0 ? yen(r.amount) : <span className="text-xs font-normal text-muted-foreground">金額未入力</span>}</span>
              </li>
            );
          })}
          {totals.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">該当する購入はありません。</li>}
        </ul>
      )}
      {tab === "history" && purchases.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">この条件の購入記録はありません。</p>}
      {tab === "products" && <p className="text-xs text-muted-foreground">セット商品の購入は「セット商品」に数量・金額を計上し、構成商品には数量だけを参考として加えます（金額は二重に数えません）。</p>}

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
