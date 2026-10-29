/**
 * コレクション（所有カードの管理）の純粋な計算・照合。画面・サーバー双方から使う。
 *  - カードマスター（カードそのもの）と所有記録（取得ごと）は別。一覧では同じカードを1種類にまとめ、所持枚数は取得記録の合計。
 *  - 価格は「購入価格」「販売参考相場」「買取参考相場」を区別する。未設定は0円にせず、計算の対象外にする。
 *  - 参考相場は確定した売却額ではない（状態により変わる）。実際の収入・収支には計上しない。
 */

export interface CardRow {
  id: string;
  name: string;
  cardNumber: string;
  setCode: string;
  rarity: string;
  cardType: string;
  productName: string;
  imagePath: string | null;
  thumbPath: string | null;
  imageSha: string | null;
  sourceUrl: string | null;
  analysisRunId: string | null;
  createdAt: string;
}
export interface HoldingRow {
  id: string;
  cardId: string;
  quantity: number;
  acquiredOn: string | null;
  unitPriceYen: number | null;
  source: string;
  condition: string;
  note: string;
  purchaseId: string | null;
  createdAt: string;
}
export interface PriceRow {
  id: string;
  cardId: string;
  kind: "sale" | "buyback";
  amountYen: number;
  confirmedOn: string;
  source: string;
  sourceUrl: string | null;
  createdAt: string;
}
export interface FavoriteRow {
  profileId: string;
  cardId: string;
  rank: number;
}

export interface CardSummaryRow extends CardRow {
  /** 所持枚数（取得記録の合計） */
  qty: number;
  holdings: HoldingRow[];
  /** 購入額の合計（価格が分かる取得記録のみ）。1件も分からなければ null */
  costTotal: number | null;
  /** 購入価格が未入力の枚数 */
  costUnknownQty: number;
  sale: PriceRow | null;
  buyback: PriceRow | null;
  /** 所持枚数×参考相場。相場が未設定なら null（0円にしない） */
  saleValue: number | null;
  buybackValue: number | null;
  /** 並び替え・集計の「参考価値」。販売参考があればそれ、なければ買取参考 */
  refValue: number | null;
  /** 購入額との差額（参考相場 − 購入額）。購入価格が全枚数分そろっていて、相場もあるときだけ */
  saleDiff: number | null;
  buybackDiff: number | null;
  lastAcquiredOn: string | null;
  favRank: number | null;
}

/** 最新の参考相場（確認日が新しいもの、同日なら登録が新しいもの） */
export function latestPrice(prices: PriceRow[], kind: PriceRow["kind"]): PriceRow | null {
  let best: PriceRow | null = null;
  for (const p of prices) {
    if (p.kind !== kind) continue;
    if (!best || p.confirmedOn > best.confirmedOn || (p.confirmedOn === best.confirmedOn && p.createdAt > best.createdAt)) best = p;
  }
  return best;
}

export function summarizeCards(cards: CardRow[], holdings: HoldingRow[], prices: PriceRow[], favorites: FavoriteRow[], profileId: string | null): CardSummaryRow[] {
  const byCardH = new Map<string, HoldingRow[]>();
  for (const h of holdings) byCardH.set(h.cardId, [...(byCardH.get(h.cardId) ?? []), h]);
  const byCardP = new Map<string, PriceRow[]>();
  for (const p of prices) byCardP.set(p.cardId, [...(byCardP.get(p.cardId) ?? []), p]);
  const fav = new Map(favorites.filter((f) => f.profileId === profileId).map((f) => [f.cardId, f.rank]));
  return cards.map((c) => {
    const hs = (byCardH.get(c.id) ?? []).slice().sort((a, b) => (b.acquiredOn ?? "").localeCompare(a.acquiredOn ?? "") || b.createdAt.localeCompare(a.createdAt));
    const qty = hs.reduce((s, h) => s + h.quantity, 0);
    const known = hs.filter((h) => h.unitPriceYen !== null);
    const costTotal = known.length > 0 ? known.reduce((s, h) => s + (h.unitPriceYen as number) * h.quantity, 0) : null;
    const costUnknownQty = hs.filter((h) => h.unitPriceYen === null).reduce((s, h) => s + h.quantity, 0);
    const ps = byCardP.get(c.id) ?? [];
    const sale = latestPrice(ps, "sale");
    const buyback = latestPrice(ps, "buyback");
    const saleValue = sale ? sale.amountYen * qty : null;
    const buybackValue = buyback ? buyback.amountYen * qty : null;
    const costComplete = costTotal !== null && costUnknownQty === 0;
    return {
      ...c,
      qty,
      holdings: hs,
      costTotal,
      costUnknownQty,
      sale,
      buyback,
      saleValue,
      buybackValue,
      refValue: saleValue ?? buybackValue,
      saleDiff: costComplete && saleValue !== null ? saleValue - (costTotal as number) : null,
      buybackDiff: costComplete && buybackValue !== null ? buybackValue - (costTotal as number) : null,
      lastAcquiredOn: hs.map((h) => h.acquiredOn).filter((d): d is string => !!d).sort().at(-1) ?? null,
      favRank: fav.has(c.id) ? (fav.get(c.id) as number) : null,
    };
  });
}

// ---------------------------------------------------------------- 検索・絞り込み・並び替え
export type SortKey = "default" | "fav" | "valueDesc" | "valueAsc" | "qty" | "acquired" | "created" | "name";
export interface CollectionFilters {
  q: string;
  favOnly: boolean;
  rarity: string;
  product: string;
  /** all / multi（2枚以上） */
  qty: "all" | "multi";
  /** all / yes（相場あり） / no（相場なし） */
  priced: "all" | "yes" | "no";
  /** all / yes（画像あり） / no（画像なし） */
  image: "all" | "yes" | "no";
}
export const DEFAULT_FILTERS: CollectionFilters = { q: "", favOnly: false, rarity: "", product: "", qty: "all", priced: "all", image: "all" };

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

export function filterCards(rows: CardSummaryRow[], f: CollectionFilters): CardSummaryRow[] {
  const q = norm(f.q);
  return rows.filter((r) => {
    if (q && !norm(`${r.name}${r.cardNumber}${r.setCode}${r.productName}${r.rarity}`).includes(q)) return false;
    if (f.favOnly && r.favRank === null) return false;
    if (f.rarity && r.rarity !== f.rarity) return false;
    if (f.product && r.productName !== f.product) return false;
    if (f.qty === "multi" && r.qty < 2) return false;
    if (f.priced === "yes" && r.refValue === null) return false;
    if (f.priced === "no" && r.refValue !== null) return false;
    if (f.image === "yes" && !r.thumbPath) return false;
    if (f.image === "no" && r.thumbPath) return false;
    return true;
  });
}

/** 価値が未設定のカードは、どの並びでも末尾（0円として扱わない） */
const byValue = (a: CardSummaryRow, b: CardSummaryRow, dir: 1 | -1) => {
  if (a.refValue === null && b.refValue === null) return 0;
  if (a.refValue === null) return 1;
  if (b.refValue === null) return -1;
  return (a.refValue - b.refValue) * dir;
};

export function sortCards(rows: CardSummaryRow[], key: SortKey): CardSummaryRow[] {
  const out = rows.slice();
  const name = (a: CardSummaryRow, b: CardSummaryRow) => a.name.localeCompare(b.name, "ja");
  out.sort((a, b) => {
    const r = (() => {
      switch (key) {
        case "default":
        case "fav": {
          // お気に入り → お気に入り内の順位 → 参考価値の高い順
          if ((a.favRank === null) !== (b.favRank === null)) return a.favRank === null ? 1 : -1;
          if (a.favRank !== null && b.favRank !== null && a.favRank !== b.favRank) return a.favRank - b.favRank;
          return key === "fav" ? 0 : byValue(a, b, -1);
        }
        case "valueDesc":
          return byValue(a, b, -1);
        case "valueAsc":
          return byValue(a, b, 1);
        case "qty":
          return b.qty - a.qty;
        case "acquired":
          return (b.lastAcquiredOn ?? "").localeCompare(a.lastAcquiredOn ?? "");
        case "created":
          return b.createdAt.localeCompare(a.createdAt);
        case "name":
          return name(a, b);
      }
    })();
    return r || name(a, b);
  });
  return out;
}

// ---------------------------------------------------------------- 集計
export interface CollectionTotals {
  kinds: number;
  qty: number;
  costTotal: number;
  /** 購入価格が未入力の枚数（購入額合計に含まれない） */
  costUnknownQty: number;
  saleTotal: number;
  /** 販売参考相場が未設定のカード種類数（参考価値合計に含まれない） */
  saleMissingKinds: number;
  buybackTotal: number;
  buybackMissingKinds: number;
  /** 購入額との差額（購入価格が全枚数分そろい、相場もあるカードだけの合計） */
  saleDiff: number;
  saleDiffKinds: number;
  buybackDiff: number;
  buybackDiffKinds: number;
}

export function totalsOf(rows: CardSummaryRow[]): CollectionTotals {
  const held = rows.filter((r) => r.qty > 0);
  const t: CollectionTotals = { kinds: held.length, qty: 0, costTotal: 0, costUnknownQty: 0, saleTotal: 0, saleMissingKinds: 0, buybackTotal: 0, buybackMissingKinds: 0, saleDiff: 0, saleDiffKinds: 0, buybackDiff: 0, buybackDiffKinds: 0 };
  for (const r of held) {
    t.qty += r.qty;
    t.costTotal += r.costTotal ?? 0;
    t.costUnknownQty += r.costUnknownQty;
    if (r.saleValue === null) t.saleMissingKinds++;
    else t.saleTotal += r.saleValue;
    if (r.buybackValue === null) t.buybackMissingKinds++;
    else t.buybackTotal += r.buybackValue;
    if (r.saleDiff !== null) {
      t.saleDiff += r.saleDiff;
      t.saleDiffKinds++;
    }
    if (r.buybackDiff !== null) {
      t.buybackDiff += r.buybackDiff;
      t.buybackDiffKinds++;
    }
  }
  return t;
}

export function breakdown(rows: CardSummaryRow[], by: "rarity" | "productName"): { key: string; kinds: number; qty: number }[] {
  const m = new Map<string, { kinds: number; qty: number }>();
  for (const r of rows) {
    if (r.qty <= 0) continue;
    const k = r[by] || "（未設定）";
    const cur = m.get(k) ?? { kinds: 0, qty: 0 };
    m.set(k, { kinds: cur.kinds + 1, qty: cur.qty + r.qty });
  }
  return [...m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.qty - a.qty || a.key.localeCompare(b.key, "ja"));
}

// ---------------------------------------------------------------- カードマスターとの照合（名称の類似だけでは統合しない）
export interface CardIdentity {
  name: string;
  cardNumber: string;
  setCode: string;
  rarity: string;
}
export type CardMatch = { kind: "exact"; card: CardRow } | { kind: "candidates"; candidates: CardRow[] } | { kind: "none" };

const key = (s: string) => norm(s);

/**
 * exact: 商品・セットコード＋カード番号＋レアリティがすべて一致（または、番号とセットコードが一致しレアリティが片方だけ未入力でない場合は候補）。
 * candidates: 番号が同じ・名称が同じなど、同じカードの可能性があるもの（利用者が選ぶ。自動では確定しない）。
 * 同名で番号・レアリティ・収録商品が違うカードは別のカード。
 */
export function matchCard(id: CardIdentity, cards: CardRow[]): CardMatch {
  const num = key(id.cardNumber);
  const set = key(id.setCode);
  const rar = key(id.rarity);
  if (num && set && rar) {
    const hit = cards.find((c) => key(c.cardNumber) === num && key(c.setCode) === set && key(c.rarity) === rar);
    if (hit) return { kind: "exact", card: hit };
  }
  const nm = key(id.name);
  const cand = new Map<string, CardRow>();
  for (const c of cards) {
    const sameNum = num && key(c.cardNumber) === num;
    const sameName = nm && key(c.name) === nm;
    if (sameNum && (!set || !c.setCode || key(c.setCode) === set)) cand.set(c.id, c);
    else if (sameName && (!num || !c.cardNumber)) cand.set(c.id, c);
  }
  // 番号まで一致した候補を先に
  const list = [...cand.values()].sort((a, b) => Number(key(b.cardNumber) === num) - Number(key(a.cardNumber) === num));
  return list.length > 0 ? { kind: "candidates", candidates: list.slice(0, 5) } : { kind: "none" };
}

/** 一括登録の中で同じカードが重なっていないか（同じ画像、または番号・セット・レアリティが同じ） */
export function batchDuplicateKey(id: CardIdentity, sha: string | null): string[] {
  const keys: string[] = [];
  if (sha) keys.push(`sha:${sha}`);
  if (id.cardNumber && id.setCode && id.rarity) keys.push(`id:${key(id.setCode)}|${key(id.cardNumber)}|${key(id.rarity)}`);
  return keys;
}

/** ハイレアリティ（光沢の演出の対象）。控えめな演出に限る */
export const SHINE_RARITIES = ["SAR", "UR", "SSR", "HR", "CSR", "CHR", "BWR", "AR", "SR", "ACE"];
export const isShine = (rarity: string) => SHINE_RARITIES.includes(rarity.trim().toUpperCase());
