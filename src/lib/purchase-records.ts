import { flexToJstDate, productName, purchaseTotal, UNIT_LABEL } from "@/lib/finance";
import type { AppData, ItemUnit, Purchase, PurchaseItem } from "@/types/domain";

/**
 * 購入記録の表示用集計（純関数）。購入記録は収支の支出と同じデータ(purchases)で、別に複製を持たないため
 * 収支画面・抽選の購入済み・購入記録画面のどこで登録・編集・削除しても同じ内容が見える。
 * 金額が未入力の明細は0円とみなさず、件数を別に数える。セット商品の購入は「セット商品」に計上し、
 * 構成商品へは数量(参考)だけを加え、金額は配らない（二重計上しない）。
 */

export type PeriodKind = "month" | "year" | "all";

export interface Period {
  kind: PeriodKind;
  /** month: "YYYY-MM" / year: "YYYY" / all: "" */
  value: string;
}

export interface PurchaseFilter {
  period: Period;
  productId: string;
  storeId: string;
}

export const ALL_PURCHASES: PurchaseFilter = { period: { kind: "all", value: "" }, productId: "", storeId: "" };

export function inPeriod(date: string | null, p: Period): boolean {
  if (p.kind === "all") return true;
  if (!date) return false; // 日付不明の購入は期間を指定したときは含めない（全期間では含める）
  return date.startsWith(p.value);
}

/** 条件に合う購入。商品で絞るときは、その商品を含む購入だけを対象にする */
export function filterPurchases(data: AppData, f: PurchaseFilter): Purchase[] {
  return data.purchases
    .filter((p) => {
      if (!inPeriod(flexToJstDate(p.purchasedOn), f.period)) return false;
      if (f.storeId && p.storeId !== f.storeId) return false;
      if (f.productId && !p.items.some((i) => i.productId === f.productId)) return false;
      return true;
    })
    .sort((a, b) => codeOf(b).localeCompare(codeOf(a)) || b.id.localeCompare(a.id));
}

const codeOf = (p: Purchase) => flexToJstDate(p.purchasedOn) ?? "";

export interface PurchaseSummary {
  /** 購入件数（取引の数） */
  count: number;
  /** 金額が入力されている明細の合計 */
  amount: number;
  /** 金額が未入力の明細数（合計に含まれない） */
  amountUnknown: number;
}

export function summarize(purchases: Purchase[]): PurchaseSummary {
  let amount = 0;
  let amountUnknown = 0;
  for (const p of purchases) {
    const t = purchaseTotal(p);
    amount += t.total;
    amountUnknown += t.unknown;
  }
  return { count: purchases.length, amount, amountUnknown };
}

/** 明細の数量表記（BOX・パック・セット・個） */
export function quantityLabel(i: Pick<PurchaseItem, "quantity" | "unit">): string {
  return `${UNIT_LABEL[i.unit]}×${i.quantity}`;
}

export interface ProductTotal {
  productId: string | null;
  /** 商品名（マスター未登録の自由入力名を含む） */
  label: string;
  /** 直接購入した数量（単位ごと） */
  direct: Partial<Record<ItemUnit, number>>;
  /** BOX をパックに換算した合計（BOX×入数+パック）。入数が未設定なら null（推測しない） */
  packEquivalent: number | null;
  amount: number;
  amountUnknown: number;
  /** セット商品の購入に含まれる構成数量（セット数×構成数量）。参考値で、金額は含まない */
  viaSet: number;
}

/** 商品別の累計購入数量。購入記録の絞り込み条件（期間・店舗）に従う */
export function productTotals(data: AppData, purchases: Purchase[], onlyProductId = ""): ProductTotal[] {
  const map = new Map<string, ProductTotal>();
  const get = (productId: string | null, label: string) => {
    const key = productId ?? `label:${label}`;
    let r = map.get(key);
    if (!r) {
      r = { productId, label, direct: {}, packEquivalent: null, amount: 0, amountUnknown: 0, viaSet: 0 };
      map.set(key, r);
    }
    return r;
  };
  const comps = new Map<string, { componentProductId: string; quantity: number }[]>();
  for (const s of data.productSetItems ?? []) comps.set(s.setProductId, [...(comps.get(s.setProductId) ?? []), s]);

  for (const p of purchases) {
    for (const it of p.items) {
      if (onlyProductId && it.productId !== onlyProductId) continue;
      const r = get(it.productId, productName(data, it.productId, it.productLabel));
      r.direct[it.unit] = (r.direct[it.unit] ?? 0) + it.quantity;
      if (it.amountPaid === null) r.amountUnknown++;
      else r.amount += it.amountPaid;
      if (it.productId) for (const c of comps.get(it.productId) ?? []) get(c.componentProductId, productName(data, c.componentProductId)).viaSet += c.quantity * it.quantity;
    }
  }
  for (const r of map.values()) {
    const per = r.productId ? data.products.find((x) => x.id === r.productId)?.packsPerBox : null;
    const boxes = r.direct.box ?? 0;
    const packs = r.direct.pack ?? 0;
    // BOX をパックに換算できるのは商品の入数が分かっているときだけ（未設定は推測せず null）
    if (boxes === 0 && packs === 0) r.packEquivalent = null;
    else if (boxes > 0 && !per) r.packEquivalent = null;
    else r.packEquivalent = boxes * (per ?? 0) + packs;
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label, "ja"));
}

/** 期間の前後移動（month/year） */
export function shiftPeriod(p: Period, delta: number): Period {
  if (p.kind === "year") return { kind: "year", value: String(Number(p.value) + delta) };
  if (p.kind === "month") {
    const [y, m] = p.value.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return { kind: "month", value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` };
  }
  return p;
}

export function periodLabel(p: Period): string {
  if (p.kind === "all") return "全期間";
  if (p.kind === "year") return `${p.value}年`;
  const [y, m] = p.value.split("-");
  return `${y}年${Number(m)}月`;
}
