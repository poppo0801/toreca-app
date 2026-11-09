import { isPurchaseRecord } from "@/lib/expense-category";
import { flexToJstDate, productFullName } from "@/lib/finance";
import { inPeriod, isSingleItem, type Period } from "@/lib/purchase-records";
import type { AppData, Purchase, PurchaseItem } from "@/types/domain";

/**
 * 購入記録（Stage 7K・純関数）。趣味として「開封・使用開始した商品」と「購入したシングルカード」を、数量と実際に使った金額で見るためのページ。
 *  収支=お金の動き（購入・売却・経費）／購入記録=開封した商品・購入したシングルカード／コレクション=現在所有する物と評価額、と役割を分ける。
 *  - BOX・単品パック・デッキ/セット商品は「開封・使用開始した時点」で記録する。購入・受取しただけの未開封BOXは含めない（収支・コレクションには残る）。
 *  - シングルカードは購入した時点で記録する（収支の支出品目「シングルカード」と連動）。
 *  - 開封の金額は、その商品を実際に購入したときの金額（BOX=開封したロットの購入単価×数量）。市場相場は使わない。不明は null（0円とは別）。
 *  - 新しい支出は作らない。BOXの開封はBOX在庫の履歴から導出し、他は opening_records（購入明細との関連つき）から。二重計上しない。
 */

export type UsageKind = "open" | "single";
export type UsageSource = "box_open" | "opening" | "single_purchase";
export type UsageUnit = "box" | "pack" | "set" | "piece";

export interface UsageRecord {
  id: string;
  kind: UsageKind;
  source: UsageSource;
  /** 開封日（開封の場合）または購入日（シングルカード）。日本時間の YYYY-MM-DD。不明は null */
  date: string | null;
  productId: string | null;
  /** 表示名（商品マスターの正式名称。未登録は入力された名称） */
  label: string;
  unit: UsageUnit;
  quantity: number;
  /** パック換算（BOX×入数＋パック）。入数が不明なBOXは換算せず null（推測しない）。パック以外のセット商品等は null */
  packEquivalent: number | null;
  /** 開封分の購入金額。不明は null */
  amount: number | null;
  profileId: string | null;
  storeId: string | null;
  /** 画像・単位表記の品目（シングルカードは single_card） */
  category: string;
  /** 元のレコードのID（開封記録のID／BOX開封の行ID／購入のID） */
  refId: string;
  purchaseId?: string;
  purchaseItemId?: string | null;
}

const jstDate = (iso: string): string => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);

export function buildUsageRecords(data: AppData): UsageRecord[] {
  const out: UsageRecord[] = [];
  const product = (id: string | null) => (id ? data.products.find((p) => p.id === id) : undefined);

  // 1. BOXの開封（BOXコレクション > 開封済みにする）。開封した日・数量・開封したプロフィール。金額=ロットの実際の購入単価×数量
  for (const o of data.boxOpenings ?? []) {
    const per = product(o.productId)?.packsPerBox ?? null;
    out.push({
      id: `box:${o.id}`,
      kind: "open",
      source: "box_open",
      date: jstDate(o.occurredAt),
      productId: o.productId,
      label: productFullName(data, o.productId),
      unit: "box",
      quantity: o.quantity,
      packEquivalent: per ? o.quantity * per : null,
      amount: o.unitPrice !== null ? o.unitPrice * o.quantity : null,
      profileId: o.profileId,
      storeId: o.storeId,
      category: "pokemon_card",
      refId: o.id,
      purchaseItemId: o.purchaseItemId,
    });
  }

  // 2. 単品パック・デッキ・セット商品などの開封・使用開始（直接登録、または不明な購入の確認）
  for (const r of data.openingRecords ?? []) {
    const linked = r.purchaseItemId ? findItem(data, r.purchaseItemId) : null;
    out.push({
      id: `open:${r.id}`,
      kind: "open",
      source: "opening",
      date: r.openedOn,
      productId: r.productId,
      label: productFullName(data, r.productId, r.label),
      unit: r.unit,
      quantity: r.quantity,
      packEquivalent: r.unit === "pack" ? r.quantity : null,
      amount: r.amountYen,
      profileId: r.profileId,
      storeId: linked?.purchase.storeId ?? null,
      category: "pokemon_card",
      refId: r.id,
      purchaseId: linked?.purchase.id,
      purchaseItemId: r.purchaseItemId,
    });
  }

  // 3. シングルカードは購入した時点（収支の支出品目と連動）。金額が未入力なら null
  for (const p of data.purchases) {
    if (!isPurchaseRecord(p)) continue;
    for (const i of p.items) {
      if (!isSingleItem(p, i)) continue;
      out.push({
        id: `single:${i.id ?? `${p.id}:${i.productLabel ?? ""}`}`,
        kind: "single",
        source: "single_purchase",
        date: flexToJstDate(p.purchasedOn),
        productId: i.productId,
        label: productFullName(data, i.productId, i.productLabel),
        unit: "piece",
        quantity: i.quantity,
        packEquivalent: null,
        amount: i.amountPaid,
        profileId: null,
        storeId: p.storeId,
        category: "single_card",
        refId: p.id,
        purchaseId: p.id,
        purchaseItemId: i.id ?? null,
      });
    }
  }
  return out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.id.localeCompare(a.id));
}

function findItem(data: AppData, itemId: string): { purchase: Purchase; item: PurchaseItem } | null {
  for (const p of data.purchases) {
    const item = p.items.find((i) => i.id === itemId);
    if (item) return { purchase: p, item };
  }
  return null;
}

// ---------------------------------------------------------------- BOX在庫の履歴から開封実績を導出
export interface MovementRow {
  id: string;
  lot_id: string;
  kind: string;
  qty: number;
  op_id: string | null;
  reverts_op: string | null;
  occurred_at: string;
  created_by_profile_id: string | null;
}
export interface LotRow {
  id: string;
  product_id: string;
  actual_unit_price: number | null;
  store_id: string | null;
  purchase_item_id: string | null;
}

/**
 * BOX在庫の履歴（box_movements）から、開封実績を導出する。開封の行（qty<0）を操作×ロットでまとめ、取り消された操作（reverts_op）は除く。
 * 金額の元になる単価は、開封したロットの実際の購入単価（市場相場は使わない）。新しい支出や在庫の変更は行わない（読み取りのみ）。
 */
export function deriveBoxOpenings(movements: MovementRow[], lots: LotRow[]): NonNullable<AppData["boxOpenings"]> {
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const reverted = new Set(movements.filter((m) => m.reverts_op).map((m) => `${m.reverts_op}|${m.lot_id}`));
  const byOp = new Map<string, { opId: string; lotId: string; qty: number; at: string; by: string | null; id: string }>();
  for (const m of movements) {
    if (m.kind !== "open" || m.qty >= 0 || !m.op_id || m.reverts_op) continue;
    if (reverted.has(`${m.op_id}|${m.lot_id}`)) continue;
    const k = `${m.op_id}|${m.lot_id}`;
    const cur = byOp.get(k);
    if (cur) cur.qty += -m.qty;
    else byOp.set(k, { opId: m.op_id, lotId: m.lot_id, qty: -m.qty, at: m.occurred_at, by: m.created_by_profile_id, id: m.id });
  }
  return [...byOp.values()].flatMap((o) => {
    const lot = lotById.get(o.lotId);
    return lot ? [{ id: o.id, opId: o.opId, lotId: o.lotId, productId: lot.product_id, quantity: o.qty, occurredAt: o.at, profileId: o.by, unitPrice: lot.actual_unit_price, storeId: lot.store_id, purchaseItemId: lot.purchase_item_id }] : [];
  });
}

// ---------------------------------------------------------------- 絞り込み・集計
export interface UsageFilter {
  period: Period;
  productId: string;
  storeId: string;
  /** all=すべて / open=開封 / single=シングルカード */
  kind: "all" | UsageKind;
  /** プロフィールで絞り込む（空=すべて）。シングルカードはプロフィールを持たないので、絞り込み中は含めない */
  profileId: string;
}
export const ALL_USAGE: Omit<UsageFilter, "period"> = { productId: "", storeId: "", kind: "all", profileId: "" };

/** 期間は、開封の場合は開封日、シングルカードの場合は購入日を基準にする。上部集計・商品別累計・履歴のすべてに同じ条件を使う */
export function filterUsage(records: UsageRecord[], f: UsageFilter): UsageRecord[] {
  return records.filter(
    (r) =>
      inPeriod(r.date, f.period) &&
      (f.kind === "all" || r.kind === f.kind) &&
      (!f.productId || r.productId === f.productId) &&
      (!f.storeId || r.storeId === f.storeId) &&
      (!f.profileId || r.profileId === f.profileId),
  );
}

export interface UsageStats {
  /** 開封したBOXの合計 */
  box: number;
  /** パック（開封BOXのパック換算＋開封した単品パック）。入数が不明なBOXは換算しない */
  pack: number;
  packUnknownBoxes: number;
  /** その他商品（開封・使用開始したデッキ・セット商品などの個数）。シングルカードは含めない */
  other: number;
  /** シングルカードの購入枚数（参考。4項目の集計には出さない） */
  single: number;
  /** 総額（金額が分かる記録の合計。売却収入は差し引かない。金額未設定は0円とみなさない） */
  amount: number;
  /** 金額が未設定の記録の件数（総額に含まれない） */
  amountUnknown: number;
}

export function usageStats(records: UsageRecord[]): UsageStats {
  const s: UsageStats = { box: 0, pack: 0, packUnknownBoxes: 0, other: 0, single: 0, amount: 0, amountUnknown: 0 };
  for (const r of records) {
    if (r.amount === null) s.amountUnknown++;
    else s.amount += r.amount;
    if (r.kind === "single") {
      s.single += r.quantity;
      continue;
    }
    if (r.unit === "box") {
      s.box += r.quantity;
      if (r.packEquivalent !== null) s.pack += r.packEquivalent;
      else s.packUnknownBoxes += r.quantity;
    } else if (r.unit === "pack") s.pack += r.quantity;
    else s.other += r.quantity;
  }
  return s;
}

export interface UsageTotal {
  productId: string | null;
  label: string;
  boxes: number;
  /** パックの合計（BOXのパック換算＋単品パック） */
  packs: number;
  /** 単品パックの開封数（BOXの換算分を含まない） */
  directPacks: number;
  /** セット・個（デッキ・セット商品など） */
  sets: number;
  singleQty: number;
  /** BOX×入数＋パック。入数が不明なBOXが含まれるときは null（推測しない） */
  packEquivalent: number | null;
  amount: number;
  amountUnknown: number;
  category: string;
  single: boolean;
}

/** 商品別の累計（マスターIDで集計。マスター未登録は正規化した名称が同じものだけをまとめる） */
export function usageTotals(records: UsageRecord[]): UsageTotal[] {
  const map = new Map<string, UsageTotal & { unknownBoxes: number }>();
  for (const r of records) {
    const single = r.kind === "single";
    const key = r.productId ?? `label:${single ? "s" : "p"}:${r.label.normalize("NFKC").trim()}`;
    let t = map.get(key);
    if (!t) {
      t = { productId: r.productId, label: r.label.trim(), boxes: 0, packs: 0, directPacks: 0, sets: 0, singleQty: 0, packEquivalent: null, amount: 0, amountUnknown: 0, category: r.category, single, unknownBoxes: 0 };
      map.set(key, t);
    }
    if (r.amount === null) t.amountUnknown++;
    else t.amount += r.amount;
    if (single) t.singleQty += r.quantity;
    else if (r.unit === "box") {
      t.boxes += r.quantity;
      if (r.packEquivalent !== null) t.packs += r.packEquivalent;
      else t.unknownBoxes += r.quantity;
    } else if (r.unit === "pack") {
      t.packs += r.quantity;
      t.directPacks += r.quantity;
    } else t.sets += r.quantity;
  }
  const rows = [...map.values()].map(({ unknownBoxes, ...t }) => ({ ...t, packEquivalent: unknownBoxes > 0 || t.packs === 0 ? null : t.packs }));
  const qty = (t: UsageTotal) => t.packEquivalent ?? t.boxes + t.sets + t.singleQty;
  return rows.sort((a, b) => qty(b) - qty(a) || a.label.localeCompare(b.label, "ja"));
}

// ---------------------------------------------------------------- 既存の購入履歴の分類（開封済み／未開封／開封状態が不明）
export interface UnconfirmedPurchase {
  purchaseId: string;
  itemId: string;
  productId: string | null;
  label: string;
  unit: "pack" | "set" | "piece";
  /** まだ開封の確認が済んでいない数量 */
  remaining: number;
  /** 購入明細の数量 */
  quantity: number;
  date: string | null;
  amountPaid: number | null;
  storeId: string | null;
}
export interface PurchaseClassification {
  /** 開封済みと確認できる数量（BOXは開封実績、その他は確認済みの記録） */
  opened: number;
  /** 未開封と確認できる数量（BOXコレクションに在庫としてあるもの） */
  unopened: number;
  /** 開封状態が不明な明細（単品パック・セット商品など） */
  unknown: UnconfirmedPurchase[];
  /** BOXコレクションに未登録のため、開封状態が不明な購入BOX（明細の数） */
  boxUnregistered: number;
}

/**
 * 既存の購入明細を3つに分類する。開封済みと確認できるものだけが開封実績になる。未開封はコレクションに在庫として残り、
 * 不明なものは勝手に開封済みと推定せず、後から確認して登録できる（opening_records の購入明細への関連で二重計上しない）。
 */
export function classifyPurchases(data: AppData): PurchaseClassification {
  const r: PurchaseClassification = { opened: 0, unopened: 0, unknown: [], boxUnregistered: 0 };
  const lotItems = new Set(data.boxLotItemIds ?? []);
  const openedByItem = new Map<string, number>();
  for (const o of data.boxOpenings ?? []) if (o.purchaseItemId) openedByItem.set(o.purchaseItemId, (openedByItem.get(o.purchaseItemId) ?? 0) + o.quantity);
  const linkedByItem = new Map<string, number>();
  for (const o of data.openingRecords ?? []) if (o.purchaseItemId) linkedByItem.set(o.purchaseItemId, (linkedByItem.get(o.purchaseItemId) ?? 0) + o.quantity);
  for (const p of data.purchases) {
    if (!isPurchaseRecord(p) || p.category === "other") continue;
    for (const i of p.items) {
      if (!i.id || isSingleItem(p, i)) continue;
      if (i.unit === "box") {
        if (lotItems.has(i.id)) {
          const opened = Math.min(i.quantity, openedByItem.get(i.id) ?? 0);
          r.opened += opened;
          r.unopened += i.quantity - opened;
        } else r.boxUnregistered++;
        continue;
      }
      if (i.unit !== "pack" && i.unit !== "set" && i.unit !== "piece") continue;
      const linked = Math.min(i.quantity, linkedByItem.get(i.id) ?? 0);
      r.opened += linked;
      const remaining = i.quantity - linked;
      if (remaining > 0) r.unknown.push({ purchaseId: p.id, itemId: i.id, productId: i.productId, label: productFullName(data, i.productId, i.productLabel), unit: i.unit, remaining, quantity: i.quantity, date: flexToJstDate(p.purchasedOn), amountPaid: i.amountPaid, storeId: p.storeId });
    }
  }
  r.unknown.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.itemId.localeCompare(b.itemId));
  return r;
}

/** 開封分の購入金額: 購入明細の金額を数量で按分（円未満は四捨五入）。購入金額が不明なら null（市場相場は使わない） */
export function proratedAmount(amountPaid: number | null, itemQuantity: number, openedQuantity: number): number | null {
  if (amountPaid === null || itemQuantity <= 0) return null;
  return openedQuantity === itemQuantity ? amountPaid : Math.round((amountPaid * openedQuantity) / itemQuantity);
}

export const USAGE_UNIT_LABEL: Record<UsageUnit, string> = { box: "BOX", pack: "パック", set: "セット", piece: "個" };
