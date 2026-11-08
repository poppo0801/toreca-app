import { isPurchaseRecord } from "@/lib/expense-category";
import { flexToJstDate, productName, purchaseTotal, unitLabelFor } from "@/lib/finance";
import type { AppData, Purchase, PurchaseItem, PurchaseUnit } from "@/types/domain";

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
  // 購入記録に載せるのはポケモンカード・シングルカード・その他の購入（周辺グッズ・経費は収支にだけ計上し、BOX数・枚数には含めない）
  return data.purchases
    .filter((p) => {
      if (!isPurchaseRecord(p)) return false;
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

/** 明細の数量表記。数量を先、単位を後に出す（3BOX・2パック・6個・3枚）。シングルカードは枚 */
export function quantityLabel(i: Pick<PurchaseItem, "quantity" | "unit">, category?: string | null): string {
  return `${i.quantity}${unitLabelFor(i.unit, category)}`;
}

/** シングルカードの明細か（品目がシングルカード、または商品マスターに紐づかない「シングル…」の自由入力。旧データの記録を含む） */
export function isSingleItem(p: Pick<Purchase, "category">, i: Pick<PurchaseItem, "productId" | "productLabel">): boolean {
  return p.category === "single_card" || (!i.productId && /シングル/.test(i.productLabel ?? ""));
}

export interface PurchaseStats {
  /** 購入したBOXの合計数量 */
  box: number;
  /** パックの総数（単品パック＋BOXをパックに換算した分）。入数が不明なBOXは換算しない（推測しない） */
  pack: number;
  /** 入数が不明でパックに換算できなかったBOXの数 */
  packUnknownBoxes: number;
  /** その他商品（デッキ・セット商品などの購入個数）。BOX・パック・シングルカードは含めない。支出品目の「その他」とは別 */
  other: number;
  /** シングルカードの枚数（参考。4項目の集計には出さない） */
  single: number;
  /** 総額（金額が入力されている明細の合計。BOXのパック換算で二重計上しない） */
  amount: number;
  amountUnknown: number;
}

/** 購入記録の上部の集計（BOX・パック・その他商品・総額）。表示している購入の範囲で数える */
export function purchaseStats(data: AppData, purchases: Purchase[]): PurchaseStats {
  const s: PurchaseStats = { box: 0, pack: 0, packUnknownBoxes: 0, other: 0, single: 0, amount: 0, amountUnknown: 0 };
  for (const p of purchases) {
    const t = purchaseTotal(p);
    s.amount += t.total;
    s.amountUnknown += t.unknown;
    for (const i of p.items) {
      if (isSingleItem(p, i)) {
        s.single += i.quantity;
        continue;
      }
      if (p.category === "other") continue; // 支出品目「その他」はカード関連商品ではない
      if (i.unit === "box") {
        s.box += i.quantity;
        const per = i.productId ? data.products.find((x) => x.id === i.productId)?.packsPerBox : null;
        if (per) s.pack += i.quantity * per;
        else s.packUnknownBoxes += i.quantity;
      } else if (i.unit === "pack") s.pack += i.quantity;
      else s.other += i.quantity; // セット・個（デッキ・セット商品など）
    }
  }
  return s;
}

export interface ProductTotal {
  productId: string | null;
  /** 商品名（マスター未登録の自由入力名を含む） */
  label: string;
  /** 直接購入した数量（単位ごと） */
  direct: Partial<Record<PurchaseUnit, number>>;
  /** BOX をパックに換算した合計（BOX×入数+パック）。入数が未設定なら null（推測しない） */
  packEquivalent: number | null;
  amount: number;
  amountUnknown: number;
  /** セット商品の購入に含まれる構成数量（セット数×構成数量）。参考値で、金額は含まない */
  viaSet: number;
  /** 品目（購入の品目。画像・単位の表記に使う）。同じ商品で品目が混在するときは最初のもの */
  category: string;
  /** シングルカード（枚で数える）の行か */
  single: boolean;
}

/** 商品別の累計購入数量。購入記録の絞り込み条件（期間・店舗）に従う */
export function productTotals(data: AppData, purchases: Purchase[], onlyProductId = ""): ProductTotal[] {
  const map = new Map<string, ProductTotal>();
  const get = (productId: string | null, label: string, category = "pokemon_card", single = false) => {
    // 商品マスターのIDで集計する。マスター未紐づけは正規化した名称が同じものだけをまとめる（名称が似ているだけの別商品は統合しない）
    const key = productId ?? `label:${category === "single_card" || single ? "s" : "p"}:${label.normalize("NFKC").trim()}`;
    let r = map.get(key);
    if (!r) {
      r = { productId, label: label.trim(), direct: {}, packEquivalent: null, amount: 0, amountUnknown: 0, viaSet: 0, category, single };
      map.set(key, r);
    }
    return r;
  };
  const comps = new Map<string, { componentProductId: string; quantity: number }[]>();
  for (const s of data.productSetItems ?? []) comps.set(s.setProductId, [...(comps.get(s.setProductId) ?? []), s]);

  for (const p of purchases) {
    for (const it of p.items) {
      if (onlyProductId && it.productId !== onlyProductId) continue;
      const r = get(it.productId, productName(data, it.productId, it.productLabel), p.category ?? "pokemon_card", isSingleItem(p, it));
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
  // 数量の多い順（金額よりも購入数量を優先）。同数なら名称順
  const qty = (r: ProductTotal) => r.packEquivalent ?? Object.values(r.direct).reduce((n, v) => n + (v ?? 0), 0);
  return [...map.values()].sort((a, b) => qty(b) - qty(a) || a.label.localeCompare(b.label, "ja"));
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
