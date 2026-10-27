import { jstDateString } from "@/lib/datetime";
import type { AppData, FlexibleDate, ItemUnit, Product, Purchase, Sale } from "@/types/domain";

/**
 * 収支管理の集計（純関数）。支出は購入記録(purchases)、収入は売却記録(sales)から導出し、
 * 購入実績と収支明細は同じ取引データを参照するため二重計上しない。
 * 金額が未入力(null)の購入は 0円とみなさず「金額未入力」として件数を別に数える。
 */

export type LedgerFilter = "all" | "expense" | "income";

export interface LedgerEntry {
  kind: "expense" | "income";
  id: string;
  /** JST の YYYY-MM-DD。日付不明は null */
  date: string | null;
  title: string;
  sub: string;
  /** 金額。未入力の支出は null */
  amount: number | null;
  sellerProfileId?: string;
}

export function flexToJstDate(v: FlexibleDate): string | null {
  if (v.precision === "date_only") return v.date;
  if (v.precision === "date_time") return jstDateString(new Date(v.at));
  return null;
}

export function ymOf(date: string): string {
  return date.slice(0, 7);
}

export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const UNIT_LABEL: Record<ItemUnit | "piece", string> = { box: "BOX", pack: "パック", set: "セット", piece: "個" };

/** 購入の合計金額。未入力の明細は合計に含めず件数を返す。 */
export function purchaseTotal(p: Pick<Purchase, "items">): { total: number; unknown: number } {
  let total = 0;
  let unknown = 0;
  for (const i of p.items) {
    if (i.amountPaid === null) unknown++;
    else total += i.amountPaid;
  }
  return { total, unknown };
}

export function productName(data: AppData, productId: string | null, label?: string | null): string {
  const p = productId ? data.products.find((x) => x.id === productId) : undefined;
  return p?.aliases[0] ?? p?.officialName ?? label ?? "商品未登録";
}

export function purchaseTitle(data: AppData, p: Purchase): string {
  const first = p.items[0];
  if (!first) return "購入";
  const name = productName(data, first.productId, first.productLabel);
  const more = p.items.length > 1 ? ` ほか${p.items.length - 1}件` : "";
  return `${name} ${first.quantity}${UNIT_LABEL[first.unit]}${more}`;
}

export function purchaseStoreName(data: AppData, p: Purchase): string {
  const store = p.storeId ? data.stores.find((s) => s.id === p.storeId) : undefined;
  if (store) return `${data.chains.find((c) => c.id === store.chainId)?.name ?? ""} ${store.name}`.trim();
  return p.storeLabel ?? "店舗未設定";
}

export function ledgerEntries(data: AppData, ym: string, filter: LedgerFilter, sellerId: string | "all" = "all"): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  if (filter !== "income") {
    for (const p of data.purchases) {
      const date = flexToJstDate(p.purchasedOn);
      if (!date || ymOf(date) !== ym) continue;
      const { total, unknown } = purchaseTotal(p);
      out.push({
        kind: "expense",
        id: p.id,
        date,
        title: purchaseTitle(data, p),
        sub: purchaseStoreName(data, p),
        amount: unknown === p.items.length ? null : total,
      });
    }
  }
  if (filter !== "expense") {
    for (const s of data.sales) {
      if (ymOf(s.soldOn) !== ym) continue;
      if (sellerId !== "all" && s.sellerProfileId !== sellerId) continue;
      out.push({
        kind: "income",
        id: s.id,
        date: s.soldOn,
        title: `${productName(data, s.productId, s.productLabel)} ${s.quantity}${UNIT_LABEL[s.unit]}`,
        sub: s.platform || "売却先未設定",
        amount: s.amount,
        sellerProfileId: s.sellerProfileId,
      });
    }
  }
  return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
}

export interface MonthSummary {
  expense: number;
  income: number;
  net: number;
  /** 金額が未入力の購入明細の数（支出に含まれない） */
  expenseUnknown: number;
}

export function monthSummary(data: AppData, ym: string): MonthSummary {
  let expense = 0;
  let expenseUnknown = 0;
  for (const p of data.purchases) {
    const date = flexToJstDate(p.purchasedOn);
    if (!date || ymOf(date) !== ym) continue;
    const t = purchaseTotal(p);
    expense += t.total;
    expenseUnknown += t.unknown;
  }
  const income = data.sales.filter((s) => ymOf(s.soldOn) === ym).reduce((sum, s) => sum + s.amount, 0);
  return { expense, income, net: income - expense, expenseUnknown };
}

// ------------------------------------------------------------------ 金額の仮計算
/** 定価からの仮計算。定価がない単位（セット等）は null（推測しない）。 */
export function suggestedAmount(
  product: Pick<Product, "listPriceBox" | "listPricePack"> & { listPriceUnit?: number | null } | undefined,
  unit: ItemUnit,
  quantity: number,
): number | null {
  if (!product || !Number.isFinite(quantity) || quantity < 1) return null;
  // BOX=BOX定価 / パック=1パック定価 / セット(単品・セット商品)=単品・セット定価。無ければ推測しない
  const unitPrice = unit === "box" ? product.listPriceBox : unit === "pack" ? product.listPricePack : (product.listPriceUnit ?? null);
  return unitPrice == null ? null : unitPrice * quantity;
}

// ------------------------------------------------------------------ 購入原価の紐づけ
export interface CostCandidate {
  purchaseId: string;
  itemId: string;
  label: string;
  date: string | null;
  remaining: number;
  quantity: number;
  amountPaid: number | null;
  unit: ItemUnit;
}

/** 購入明細のうち、まだ原価として使われていない数量。 */
export function remainingCostQty(data: AppData, purchaseItemId: string, excludeSaleId?: string): number {
  const item = data.purchases.flatMap((p) => p.items).find((i) => i.id === purchaseItemId);
  if (!item) return 0;
  const used = data.sales
    .filter((s) => s.costPurchaseItemId === purchaseItemId && s.id !== excludeSaleId)
    .reduce((sum, s) => sum + (s.costQuantity ?? 0), 0);
  return Math.max(0, item.quantity - used);
}

export function costCandidates(data: AppData, excludeSaleId?: string): CostCandidate[] {
  const out: CostCandidate[] = [];
  for (const p of data.purchases) {
    for (const i of p.items) {
      if (!i.id) continue;
      const remaining = remainingCostQty(data, i.id, excludeSaleId);
      if (remaining <= 0) continue;
      out.push({
        purchaseId: p.id,
        itemId: i.id,
        label: `${productName(data, i.productId, i.productLabel)} ${i.quantity}${UNIT_LABEL[i.unit]}`,
        date: flexToJstDate(p.purchasedOn),
        remaining,
        quantity: i.quantity,
        amountPaid: i.amountPaid,
        unit: i.unit,
      });
    }
  }
  return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/** 購入明細の qty 個分の原価（按分）。購入金額が未入力なら null（0円とみなさない）。 */
export function proratedCost(amountPaid: number | null, purchasedQty: number, costQty: number): number | null {
  if (amountPaid === null || purchasedQty < 1) return null;
  return Math.round((amountPaid * costQty) / purchasedQty);
}

// ------------------------------------------------------------------ 年間売却実績
export interface SellerStats {
  sellerProfileId: string | "all";
  salesCount: number;
  salesAmount: number;
  /** 原価が確定している売却の原価合計 */
  costKnown: number;
  /** 原価が確定している売却の参考利益（売却額-原価-手数料-送料） */
  profitKnown: number;
  /** 原価が確定している売却の売却額 */
  amountWithCost: number;
  /** 原価未設定の売却件数／売却額（利益未確定） */
  costUnknownCount: number;
  amountCostUnknown: number;
  fee: number;
  shipping: number;
}

const emptyStats = (id: SellerStats["sellerProfileId"]): SellerStats => ({
  sellerProfileId: id, salesCount: 0, salesAmount: 0, costKnown: 0, profitKnown: 0, amountWithCost: 0,
  costUnknownCount: 0, amountCostUnknown: 0, fee: 0, shipping: 0,
});

function addSale(st: SellerStats, s: Sale) {
  st.salesCount++;
  st.salesAmount += s.amount;
  st.fee += s.fee;
  st.shipping += s.shipping;
  if (s.costAmount === null) {
    st.costUnknownCount++;
    st.amountCostUnknown += s.amount;
  } else {
    st.costKnown += s.costAmount;
    st.amountWithCost += s.amount;
    st.profitKnown += s.amount - s.costAmount - s.fee - s.shipping;
  }
}

export function annualStats(data: AppData, year: number): { total: SellerStats; bySeller: SellerStats[] } {
  const total = emptyStats("all");
  const map = new Map<string, SellerStats>();
  for (const s of data.sales) {
    if (!s.soldOn.startsWith(`${year}-`)) continue;
    addSale(total, s);
    const st = map.get(s.sellerProfileId) ?? emptyStats(s.sellerProfileId);
    addSale(st, s);
    map.set(s.sellerProfileId, st);
  }
  return { total, bySeller: [...map.values()] };
}
