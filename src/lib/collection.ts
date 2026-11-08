/**
 * コレクション（所有カードの管理）の純粋な計算・照合。画面・サーバー双方から使う。
 *  - カードマスター（カードそのもの）と所有記録（取得ごと）は別。一覧では同じカードを1種類にまとめ、所持枚数は取得記録の合計。
 *  - 価格は「購入価格」「販売参考相場」「買取参考相場」を区別する。未設定は0円にせず、計算の対象外にする。
 *  - 参考相場は確定した売却額ではない（状態により変わる）。実際の収入・収支には計上しない。
 */

import { DEFAULT_MULTIPLIERS, valuate, type ConditionMultipliers, type GradeLine, type ValuationGrade } from "@/lib/condition-value";

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
/** 保存された並び順から、プロフィールのカードID列を取り出す（位置の昇順） */
export function orderOf(orders: readonly OrderRow[], profileId: string): string[] {
  return orders
    .filter((o) => o.profileId === profileId)
    .sort((a, b) => a.position - b.position)
    .map((o) => o.cardId);
}

/** プロフィール別の「標準」並び順（保存されたもの） */
export interface OrderRow {
  profileId: string;
  cardId: string;
  position: number;
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
  /** 手動で登録した参考相場（最新）。取得した相場は別に saleMarket / buybackMarket */
  sale: PriceRow | null;
  buyback: PriceRow | null;
  /** 評価に使っている価格の出所。manual=手動の参考相場 / market=取得した相場（手動が無いとき）/ null=価格なし。販売・買取は独立に決める */
  saleSource: PriceSource | null;
  buybackSource: PriceSource | null;
  /** 取得した状態Aの相場（あれば）。出所が market のとき、評価の基準になる */
  saleMarket: MarketPriceRow | null;
  buybackMarket: MarketPriceRow | null;
  /** 評価に使っている基準相場（1枚あたり・状態補正前） */
  saleUnitYen: number | null;
  buybackUnitYen: number | null;
  /** 相場の取得状況（取得を試みたことがあれば） */
  marketStatus: MarketStatusRow | null;
  /** 所持枚数×参考相場（状態補正後の評価額）。相場が未設定なら null（0円にしない） */
  saleValue: number | null;
  buybackValue: number | null;
  /** 状態補正をしない基準相場×所持枚数（補正後の評価額と区別して持つ） */
  saleBaseValue: number | null;
  buybackBaseValue: number | null;
  /** 状態補正の内訳（販売／買取）。状態未設定の枚数は A（基準そのまま）として計算し、その枚数を示す */
  saleLines: GradeLine[];
  buybackLines: GradeLine[];
  conditionUnsetQty: number;
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

export type PriceSource = "manual" | "market";

/** 相場の取得状況（Stage 7F）。取得を試みた結果と理由。価格そのものは持たない */
export interface MarketStatusRow {
  subjectId: string;
  status: "updated" | "unlisted" | "ambiguous" | "insufficient" | "no_price";
  saleOk: boolean;
  buybackOk: boolean;
  reason: string;
  checkedAt: string;
}

/** UTCの日時 → 日本時間の日付（YYYY-MM-DD） */
export const jstDate = (iso: string): string => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);

export interface SummarizeOptions {
  /** 状態別の倍率（%）。省略時は既定（A100/B85/C65） */
  multipliers?: ConditionMultipliers;
  /** 取得した状態別の実際の販売相場（あれば倍率より優先）。取得元の価格データは変更しない */
  market?: MarketPriceRow[];
  /** 相場の取得状況（カード単位） */
  status?: MarketStatusRow[];
}

export function summarizeCards(cards: CardRow[], holdings: HoldingRow[], prices: PriceRow[], favorites: FavoriteRow[], profileId: string | null, opts: SummarizeOptions = {}): CardSummaryRow[] {
  const mult = opts.multipliers ?? DEFAULT_MULTIPLIERS;
  // 取得した相場（Stage 7F）: 状態Aの基準相場と、状態B・Cの実際の販売相場。手動の参考相場があるカード・種別では使わない
  const actualSale = new Map<string, Partial<Record<ValuationGrade, number>>>();
  const marketA = new Map<string, { sale?: MarketPriceRow; buyback?: MarketPriceRow }>();
  for (const m of opts.market ?? []) {
    const g = m.conditionGrade ?? "A";
    if (g === "A") {
      marketA.set(m.cardId, { ...(marketA.get(m.cardId) ?? {}), [m.kind]: m });
      continue;
    }
    if (m.kind !== "sale") continue;
    actualSale.set(m.cardId, { ...(actualSale.get(m.cardId) ?? {}), [g]: m.medianYen });
  }
  const statusOf = new Map((opts.status ?? []).map((x) => [x.subjectId, x]));
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
    const hv = hs.map((h) => ({ qty: h.quantity, condition: h.condition }));
    // 価格の優先順位（販売・買取は独立）: 基準相場は ①手動の参考相場 → ②取得した基準相場（状態A）→ ③価格なし。
    // 状態B・Cの所持分は、取得した状態別の実際の販売相場があれば倍率による推定より優先し（実価格 > 推定）、なければ基準相場×倍率。
    // 取得した相場で手動の相場を上書きしない。状態別の実価格が無いのに、倍率による推定値を実価格として扱わない
    const mk = marketA.get(c.id);
    const act = actualSale.get(c.id);
    const saleMarket = mk?.sale ?? null;
    const buybackMarket = mk?.buyback ?? null;
    const saleBase = sale ? sale.amountYen : (saleMarket?.medianYen ?? null);
    const buybackBase = buyback ? buyback.amountYen : (buybackMarket?.medianYen ?? null);
    const sv = valuate(hv, saleBase, mult, act);
    const bv = valuate(hv, buybackBase, mult);
    const saleSource: PriceSource | null = sale ? "manual" : saleBase !== null || sv.value !== null ? "market" : null;
    const buybackSource: PriceSource | null = buyback ? "manual" : buybackBase !== null ? "market" : null;
    const saleValue = sv.value;
    const buybackValue = bv.value;
    const costComplete = costTotal !== null && costUnknownQty === 0;
    return {
      ...c,
      qty,
      holdings: hs,
      costTotal,
      costUnknownQty,
      sale,
      buyback,
      saleSource,
      buybackSource,
      saleMarket,
      buybackMarket,
      saleUnitYen: saleBase,
      buybackUnitYen: buybackBase,
      marketStatus: statusOf.get(c.id) ?? null,
      saleValue,
      buybackValue,
      saleBaseValue: sv.baseValue,
      buybackBaseValue: bv.baseValue,
      saleLines: sv.lines,
      buybackLines: bv.lines,
      conditionUnsetQty: sv.unsetQty,
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

/**
 * 並び替え。「標準」（default）は、現在のプロフィールが自由に並べた順（Stage 6R）。
 * order = そのプロフィールの保存順（カードIDの並び）。保存順に無いカード（あとから登録したもの）は末尾に、登録の古い順で並べる。
 * 保存順が無いプロフィールは、従来の標準（お気に入り→参考価値の高い順）のまま。他の並び順は保存順を変えない。
 */
export function sortCards(rows: CardSummaryRow[], key: SortKey, order?: readonly string[] | null): CardSummaryRow[] {
  if (key === "default" && order && order.length > 0) {
    const pos = new Map(order.map((id, i) => [id, i]));
    return rows.slice().sort((a, b) => {
      const pa = pos.get(a.id);
      const pb = pos.get(b.id);
      if (pa !== undefined && pb !== undefined) return pa - pb;
      if (pa !== undefined) return -1;
      if (pb !== undefined) return 1;
      return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    });
  }
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

/** 保有カードの価格（販売参考・買取参考）の最終取得日を「M/D」で返す（価格が1つも無ければ null） */
export function lastPriceDate(rows: CardSummaryRow[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    if (r.qty <= 0) continue;
    for (const [p, m, src] of [[r.sale, r.saleMarket, r.saleSource], [r.buyback, r.buybackMarket, r.buybackSource]] as const) {
      const d = src === "manual" ? p?.confirmedOn : src === "market" && m ? jstDate(m.fetchedAt) : null;
      if (d && (!best || d > best)) best = d;
    }
  }
  return best ? `${Number(best.slice(5, 7))}/${Number(best.slice(8, 10))}` : null;
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
 * 同名で番号・レアリティ・収録パックが違うカードは別のカード。
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

/** 演出の強さ（レアリティ別）。3=最上位（SAR・UR・HR・SSR）／2=上位（SR・CSR・CHR・BWR・ACE）／1=AR。対象外は 0 */
export function shineTier(rarity: string): 0 | 1 | 2 | 3 {
  const r = rarity.trim().toUpperCase();
  if (["SAR", "UR", "HR", "SSR"].includes(r)) return 3;
  if (["SR", "CSR", "CHR", "BWR", "ACE"].includes(r)) return 2;
  return r === "AR" ? 1 : 0;
}

/** 取得した相場（ポケカ価格比較のCSV。手動の参考相場とは別に保持。Stage 6G） */
export interface MarketPriceRow {
  cardId: string;
  kind: "sale" | "buyback";
  /** 価格が対象とする状態の区分（A=従来の集計。B/C=状態B/Cの実際の販売相場） */
  conditionGrade?: "A" | "B" | "C";
  medianYen: number;
  lowYen: number;
  highYen: number;
  sampleCount: number;
  outlierCount: number;
  shops: { shop: string; price: number; condition: string; url: string; scrapedAt: string }[];
  source: string;
  sourceUrl: string | null;
  csvUpdatedAt: string | null;
  fetchedAt: string;
}

// ---------------------------------------------------------------- 価格の取得状況（Stage 7F）
/** 取得した価格をこの日数より古いまま使っているとき、古いことを示す */
export const STALE_DAYS = 7;

export const STATUS_TEXT: Record<MarketStatusRow["status"], string> = {
  updated: "取得成功",
  unlisted: "取得元のCSVに対象カードがありません（収録外）",
  ambiguous: "商品の照合が確定していません",
  insufficient: "収録弾またはカード番号が未登録のため照合できません",
  no_price: "掲載はありますが、売切・対象外の状態のみで集計できる価格がありません",
};

export interface PriceState {
  /** ok=問題なし / warn=一部のみ・古い / none=価格なし */
  level: "ok" | "warn" | "none";
  /** 短い表示（一覧のアイコンの説明・詳細の見出し） */
  label: string;
  /** 理由・補足（詳細画面） */
  detail: string;
}

const daysSince = (iso: string, now: Date) => Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);

/** カードの価格の取得状況。手動価格は取得の失敗で消えず、取得できなかった理由・古さを区別して返す（推測で補わない） */
export function cardPriceState(r: Pick<CardSummaryRow, "saleSource" | "buybackSource" | "saleMarket" | "buybackMarket" | "marketStatus">, now: Date = new Date()): PriceState {
  const hasSale = r.saleSource !== null;
  const hasBuy = r.buybackSource !== null;
  const reason = r.marketStatus ? (r.marketStatus.reason || STATUS_TEXT[r.marketStatus.status]) : "";
  if (!hasSale && !hasBuy) {
    return { level: "none", label: r.marketStatus ? (r.marketStatus.status === "ambiguous" || r.marketStatus.status === "insufficient" ? "商品照合失敗" : r.marketStatus.status === "unlisted" ? "CSVに対象カードなし" : "価格なし") : "未取得", detail: r.marketStatus ? reason : "まだ相場を取得していません。相場を更新するか、手動で参考相場を登録できます" };
  }
  const used = [r.saleSource === "market" ? r.saleMarket : null, r.buybackSource === "market" ? r.buybackMarket : null].filter((m): m is MarketPriceRow => !!m);
  const oldest = used.length > 0 ? used.map((m) => m.fetchedAt).sort()[0] : null;
  if (oldest && daysSince(oldest, now) >= STALE_DAYS) return { level: "warn", label: `価格が古い（${daysSince(oldest, now)}日前）`, detail: "最後に取得した価格のままです。更新に失敗した場合も、取得済みの価格は消していません" };
  if (!hasSale || !hasBuy) {
    const missing = hasSale ? "買取" : "販売";
    return { level: "warn", label: hasSale ? "販売価格のみ" : "買取価格のみ", detail: `${missing}の価格は取得できていません${reason && r.marketStatus?.status === "updated" ? "（取得元に掲載がないか、対象外の状態のみ）" : reason ? `：${reason}` : ""}` };
  }
  if (r.saleSource === "manual" && r.buybackSource === "manual") return { level: "ok", label: "手動価格", detail: "手動で登録した参考相場です" };
  return { level: "ok", label: "取得成功", detail: "" };
}
