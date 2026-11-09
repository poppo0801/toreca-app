"use client";

import { PAGE_HEADING_ROW, PageHeading } from "@/components/page-heading";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/components/app-provider";
import { ExpenseDialog } from "@/components/expense-dialog";
import { OpeningDialog } from "@/components/opening-dialog";
import { PurchaseThumb } from "@/components/product-image";
import { Button } from "@/components/ui/button";
import { jstDateString } from "@/lib/datetime";
import { periodLabel, shiftPeriod, type Period, type PeriodKind } from "@/lib/purchase-records";
import { buildUsageRecords, classifyPurchases, filterUsage, usageStats, usageTotals, type UnconfirmedPurchase, type UsageKind, type UsageRecord, type UsageTotal } from "@/lib/usage-records";
import { cn } from "@/lib/utils";
import type { OpeningRecord } from "@/types/domain";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const KINDS: { value: PeriodKind; label: string }[] = [
  { value: "month", label: "月" },
  { value: "year", label: "年" },
  { value: "all", label: "全期間" },
];

/** 開封日・購入日の表示（履歴の各カードの中。日付見出しは出さない） */
function dayLabel(date: string | null): string {
  if (!date) return "日付不明";
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}

const chip = "h-9 min-w-0 shrink rounded-full border bg-input px-3 text-xs";

/** 金額の表示。未設定は0円とせず「金額未設定」 */
const amountText = (r: { amount: number; amountUnknown: number }): string => (r.amountUnknown > 0 && r.amount === 0 ? "金額未設定" : r.amountUnknown > 0 ? `総額 ${yen(r.amount)}（未設定${r.amountUnknown}件）` : `総額 ${yen(r.amount)}`);

/** 商品別累計の1行の表示内容。数量を主役にし、金額は補足にする（例: 20パック／開封1BOX｜総額7,200円） */
export function totalDisplay(r: UsageTotal): { qty: string; sub: string } {
  const amount = amountText(r);
  if (r.single) return { qty: `${r.singleQty}枚`, sub: amount };
  const parts: string[] = [];
  if (r.boxes > 0) parts.push(`開封${r.boxes}BOX`);
  if (r.directPacks > 0) parts.push(r.boxes > 0 ? `単品${r.directPacks}パック` : `開封${r.directPacks}パック`);
  if (r.sets > 0) parts.push(`${r.sets}個`);
  parts.push(amount);
  if (r.boxes + r.packs > 0) {
    // BOX・パック: 累計パック数を主役に。入数が不明なBOXがあるときは換算せず、BOX数を主役にする（推測しない）
    return { qty: r.packEquivalent !== null ? `${r.packEquivalent}パック` : r.boxes > 0 ? `${r.boxes}BOX` : `${r.packs}パック`, sub: parts.join(" ｜ ") };
  }
  return { qty: `${r.sets}個`, sub: parts.join(" ｜ ") };
}

/** 履歴の数量表記（数量→単位）。BOXはパック換算を添える（入数が不明なら添えない） */
export function usageQuantity(r: UsageRecord): string {
  if (r.kind === "single") return `${r.quantity}枚`;
  if (r.unit === "box") return `${r.quantity}BOX${r.packEquivalent !== null ? `（${r.packEquivalent}パック）` : ""}`;
  return `${r.quantity}${r.unit === "pack" ? "パック" : r.unit === "set" ? "セット" : "個"}`;
}
const SOURCE_TAG: Record<UsageRecord["source"], string> = { box_open: "BOX開封", opening: "開封記録", single_purchase: "購入" };

/**
 * 購入記録（Stage 7K）: ポケモンカードを趣味として楽しむために、何をどれだけ開封・購入し、いくら使ったかを見るページ。
 *  - 開封した商品（BOXはコレクションで開封済みにした時点、単品パック・デッキ・セット商品は開封・使用開始の記録）と、購入したシングルカードを数える。
 *  - 購入・受取しただけの未開封BOXは含めない（収支・コレクションには残る）。新しい支出は作らない（収支と二重計上しない）。
 *  - 開封の金額は実際に購入したときの金額。金額が未設定の記録は0円として集計せず、件数を示す。
 */
export function PurchasesView() {
  const { data, persistent } = useApp();
  const [period, setPeriod] = useState<Period>(() => ({ kind: "month", value: jstDateString(new Date()).slice(0, 7) }));
  const [productId, setProductId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [kind, setKind] = useState<"all" | UsageKind>("all");
  const [profileId, setProfileId] = useState("");
  // 初期表示は「商品別の累計」（左）。右が購入履歴
  const [tab, setTab] = useState<"products" | "history">("products");
  const [add, setAdd] = useState<null | "choose" | "opening" | "single">(null);
  const [editSingle, setEditSingle] = useState<string | null>(null);
  const [editOpening, setEditOpening] = useState<OpeningRecord | null>(null);
  const [confirmItem, setConfirmItem] = useState<UnconfirmedPurchase | null>(null);

  const all = useMemo(() => buildUsageRecords(data), [data]);
  const records = useMemo(() => filterUsage(all, { period, productId, storeId, kind, profileId }), [all, period, productId, storeId, kind, profileId]);
  const stats = useMemo(() => usageStats(records), [records]);
  const totals = useMemo(() => usageTotals(records), [records]);
  const classification = useMemo(() => classifyPurchases(data), [data]);

  const boughtProducts = useMemo(() => {
    const ids = new Set(all.map((r) => r.productId).filter(Boolean) as string[]);
    return data.products.filter((p) => ids.has(p.id));
  }, [all, data.products]);
  const boughtStores = useMemo(() => {
    const ids = new Set(all.map((r) => r.storeId).filter(Boolean) as string[]);
    return data.stores.filter((s) => ids.has(s.id));
  }, [all, data.stores]);
  const hasFilter = productId !== "" || storeId !== "" || kind !== "all" || profileId !== "";
  const [picker, setPicker] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  // 選べる年: 記録のある年と今年（新しい順）
  const dataYears = useMemo(() => {
    const ys = new Set<number>([Number(jstDateString(new Date()).slice(0, 4))]);
    for (const r of all) if (r.date) ys.add(Number(r.date.slice(0, 4)));
    return [...ys].sort((x, y) => y - x);
  }, [all]);

  const cells: { id: string; label: string; value: string; note?: string }[] = [
    { id: "box", label: "BOX", value: String(stats.box) },
    { id: "pack", label: "パック", value: String(stats.pack), note: stats.packUnknownBoxes > 0 ? `入数が未設定のBOX ${stats.packUnknownBoxes}個はパックに換算していません` : undefined },
    { id: "other", label: "その他商品", value: String(stats.other) },
    { id: "amount", label: "総額", value: `¥${stats.amount.toLocaleString("ja-JP")}`, note: stats.amountUnknown > 0 ? `金額未設定${stats.amountUnknown}件は含まれていません` : undefined },
  ];
  const openingById = useMemo(() => new Map((data.openingRecords ?? []).map((o) => [o.id, o])), [data.openingRecords]);

  return (
    <div className="space-y-2">
      <div className={PAGE_HEADING_ROW}>
        <PageHeading navId="purchases">購入記録</PageHeading>
        {persistent && (
          <Button size="sm" onClick={() => setAdd("choose")} data-testid="purchase-add">
            ＋記録
          </Button>
        )}
      </div>

      {/* 1. 期間選択（〈 2026年11月 〉）。開封は開封日、シングルカードは購入日で数える */}
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
      </div>
      <PeriodPicker open={picker} onOpenChange={setPicker} period={period} onPick={(p) => (setPeriod(p), setPicker(false))} years={dataYears} />

      {/* 2. 集計（BOX・パック・その他商品・総額）を横4分割の1行で */}
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
      {stats.amountUnknown > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="amount-unknown-note">
          金額未設定が{stats.amountUnknown}件あります（総額には含まれていません。0円とは扱いません）。
        </p>
      )}

      {/* 3. 商品別の累計（左）／購入履歴（右）の切替と、右側の小さな絞り込みボタン */}
      <div className="flex items-center gap-1">
        <div role="tablist" aria-label="表示の切替" className="grid min-w-0 flex-1 grid-cols-2 rounded-lg bg-muted p-0.5">
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
        <Button variant="outline" size="icon" className={cn("relative size-10 shrink-0", hasFilter && "border-primary text-primary-ink")} aria-label={hasFilter ? "絞り込み（設定中）" : "絞り込み"} aria-expanded={showFilter || hasFilter} onClick={() => setShowFilter((v) => !v)} data-testid="filter-toggle">
          <SlidersHorizontal className="size-4" aria-hidden="true" />
          {hasFilter && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-primary" aria-hidden="true" />}
        </Button>
      </div>
      {(showFilter || hasFilter) && (
        <div className="flex flex-wrap gap-1.5" data-testid="purchase-filters">
          <select aria-label="分類で絞り込み" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={cn(chip, "flex-1")} data-testid="filter-kind">
            <option value="all">分類: すべて</option>
            <option value="open">開封</option>
            <option value="single">シングルカード</option>
          </select>
          <select aria-label="プロフィールで絞り込み" value={profileId} onChange={(e) => setProfileId(e.target.value)} className={cn(chip, "flex-1")} data-testid="filter-profile">
            <option value="">プロフィール: すべて</option>
            {data.profiles
              .filter((p) => p.active !== false)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
          </select>
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
            <button type="button" className={cn(chip, "shrink-0 text-primary-ink")} onClick={() => (setProductId(""), setStoreId(""), setKind("all"), setProfileId(""))} data-testid="filter-clear">
              解除
            </button>
          )}
        </div>
      )}

      {/* 4. 一覧 */}
      {tab === "history" ? (
        <ul className="space-y-2" data-testid="purchase-list" aria-label="購入履歴">
          {records.map((r) => {
            const product = r.productId ? data.products.find((x) => x.id === r.productId) : undefined;
            const body = (
              <>
                <span className="flex h-12 w-10 shrink-0 items-center justify-center">
                  <PurchaseThumb product={product} category={r.category} heightClass="h-12" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 break-words text-sm font-medium leading-snug" data-testid="purchase-title">
                    {r.label}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 text-xs">
                    <span className="font-semibold" data-testid="purchase-qty">
                      {usageQuantity(r)}
                    </span>
                    <span className="tabular-nums text-muted-foreground" data-testid="purchase-date">
                      {r.kind === "single" ? "購入 " : "開封 "}
                      {dayLabel(r.date)}
                    </span>
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground" data-testid="purchase-source">
                    {SOURCE_TAG[r.source]}
                    {r.profileId && ` ・ ${data.profiles.find((p) => p.id === r.profileId)?.label ?? ""}`}
                  </span>
                </span>
                <span className="shrink-0 text-right text-sm font-semibold tabular-nums" data-testid="purchase-amount">
                  {r.amount === null ? <span className="text-xs font-normal text-muted-foreground">金額未設定</span> : yen(r.amount)}
                </span>
              </>
            );
            const cls = "flex min-h-16 w-full items-center gap-2.5 rounded-xl border bg-card px-2.5 py-2 text-left shadow-card hover:bg-muted disabled:hover:bg-card";
            return (
              <li key={r.id}>
                {r.source === "box_open" ? (
                  <Link href="/collection?tab=box" className={cls} data-testid="purchase-row" data-source={r.source} aria-label={`${r.label}の開封（BOXコレクションで確認・取り消し）`}>
                    {body}
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled={!persistent}
                    onClick={() => (r.source === "opening" ? setEditOpening(openingById.get(r.refId) ?? null) : setEditSingle(r.purchaseId ?? null))}
                    data-testid="purchase-row"
                    data-source={r.source}
                    className={cls}
                  >
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="space-y-2" data-testid="product-totals" aria-label="商品別の累計">
          {totals.map((r) => {
            const product = r.productId ? data.products.find((x) => x.id === r.productId) : undefined;
            const d = totalDisplay(r);
            return (
              <li key={r.productId ?? r.label} className="flex items-center gap-2.5 rounded-xl border bg-card px-2.5 py-2 shadow-card" data-testid="product-total-row">
                <span className="flex h-14 w-11 shrink-0 items-center justify-center">
                  <PurchaseThumb product={product} category={r.single ? "single_card" : r.category} heightClass="h-14" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 break-words text-[13px] font-medium leading-snug" data-testid="total-name">
                    {r.label}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground" data-testid="total-sub">
                    {d.sub}
                  </span>
                </span>
                <span className="w-20 shrink-0 text-right text-base font-bold tabular-nums" data-testid="total-qty">
                  {d.qty}
                </span>
              </li>
            );
          })}
          {totals.length === 0 && <li className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">該当する開封・シングルカードの記録はありません。</li>}
        </ul>
      )}
      {tab === "history" && records.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">この条件の記録はありません。</p>}

      {/* 開封状態が不明な購入（既存の購入記録）。勝手に開封済みとは扱わない。確認すると開封実績に加わる（収支の支出は増えない） */}
      {persistent && (classification.unknown.length > 0 || classification.boxUnregistered > 0) && (
        <details className="rounded-xl border bg-card px-3 py-2 text-sm" data-testid="unconfirmed">
          <summary className="min-h-8 cursor-pointer font-medium">開封状態が不明な購入 {classification.unknown.length + classification.boxUnregistered}件</summary>
          <p className="mt-1 text-[11px] text-muted-foreground">購入しただけでは、開封したとは数えません。開封・使用開始したものは「開封済みにする」で記録できます（収支の支出は増えません）。</p>
          <ul className="mt-2 space-y-1.5">
            {classification.unknown.map((u) => (
              <li key={u.itemId} className="flex items-center gap-2 text-xs" data-testid="unconfirmed-row">
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 break-words font-medium">{u.label}</span>
                  <span className="text-muted-foreground">
                    {u.remaining}
                    {u.unit === "pack" ? "パック" : u.unit === "set" ? "セット" : "個"}（購入 {dayLabel(u.date)}）
                  </span>
                </span>
                <Button size="sm" variant="outline" onClick={() => setConfirmItem(u)} data-testid="unconfirmed-open">
                  開封済みにする
                </Button>
              </li>
            ))}
            {classification.boxUnregistered > 0 && (
              <li className="text-xs text-muted-foreground" data-testid="unconfirmed-box">
                BOXコレクションに未登録の購入BOXが{classification.boxUnregistered}件あります。コレクションに取り込み、開封すると、ここに反映されます。
              </li>
            )}
          </ul>
        </details>
      )}

      {add === "choose" && (
        <Dialog open onOpenChange={(v) => !v && setAdd(null)}>
          <DialogContent data-testid="purchase-add-choose">
            <DialogTitle>記録する内容</DialogTitle>
            <DialogDescription className="sr-only">開封・使用開始の記録か、シングルカードの購入を選びます</DialogDescription>
            <div className="mt-2 space-y-2">
              <Button className="w-full" onClick={() => setAdd("opening")} data-testid="choose-opening">
                開封・使用開始を記録（パック・デッキ・セット）
              </Button>
              <Button className="w-full" variant="outline" onClick={() => setAdd("single")} data-testid="choose-single">
                シングルカードの購入を記録
              </Button>
              <p className="text-[11px] text-muted-foreground">BOXの開封は、コレクションの「開封済みにする」で記録されます。シングルカードの購入は収支の支出としても記録されます。</p>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {add === "opening" && <OpeningDialog mode={{ kind: "new" }} onClose={() => setAdd(null)} />}
      {add === "single" && <ExpenseDialog open onOpenChange={(v) => !v && setAdd(null)} purchase={null} />}
      {confirmItem && <OpeningDialog key={confirmItem.itemId} mode={{ kind: "confirm", item: confirmItem }} onClose={() => setConfirmItem(null)} />}
      {editOpening && <OpeningDialog key={editOpening.id} mode={{ kind: "edit", record: editOpening }} onClose={() => setEditOpening(null)} />}
      {editSingle && <ExpenseDialog key={editSingle} open onOpenChange={(v) => !v && setEditSingle(null)} purchase={data.purchases.find((p) => p.id === editSingle) ?? null} />}
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
