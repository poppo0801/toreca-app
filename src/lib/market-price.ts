/**
 * 相場CSVの解析・カード照合・集計（Stage 6G・純関数）。
 * 出典: ポケカ価格比較（https://card.pricebest.jp/data/prices.csv）。1行目は「# updated: …」のコメント行、2行目が見出し。
 *   shop_key,shop,type,kind,set,no,name,rarity,condition,price_jpy,in_stock,source_url,scraped_at
 * 方針: カード名だけでは照合しない（収録弾＋カード番号が一致し、レアリティ・名称で絞る）。状態による価格の補正はしない。
 *       手動の参考相場（card_prices）には触れず、取得した相場は別に保持する。
 */

export const MARKET_SOURCE_NAME = "ポケカ価格比較";
export const MARKET_SOURCE_URL = "https://card.pricebest.jp/data/";
export const MARKET_CSV_URL = "https://card.pricebest.jp/data/prices.csv";
export const MARKET_CSV_MAX_BYTES = 5 * 1024 * 1024;

export interface MarketRow {
  shopKey: string;
  shop: string;
  type: string; // single / box / other
  kind: "sell" | "buy";
  set: string;
  no: string;
  name: string;
  rarity: string;
  condition: string;
  price: number;
  inStock: boolean;
  url: string;
  scrapedAt: string;
}

export interface ParsedCsv {
  updatedAt: string | null;
  rows: MarketRow[];
  skipped: number;
}

const HEADER = ["shop_key", "shop", "type", "kind", "set", "no", "name", "rarity", "condition", "price_jpy", "in_stock", "source_url", "scraped_at"];

/** RFC4180 風の簡易CSV分解（引用符・引用符内のカンマと改行・""のエスケープに対応） */
export function splitCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

/** CSVを検証して行にする。見出しが違う・行が少なすぎるときは null（既存の価格は変えない） */
export function parseMarketCsv(text: string): { ok: true; value: ParsedCsv } | { ok: false; error: string } {
  const src = text.replace(/^﻿/, "");
  if (src.length === 0) return { ok: false, error: "CSVが空です" };
  let updatedAt: string | null = null;
  const lines = splitCsv(src);
  const body: string[][] = [];
  for (const l of lines) {
    if (l[0]?.startsWith("#")) {
      const m = l[0].match(/updated:\s*(\S+)/);
      if (m) updatedAt = m[1];
      continue;
    }
    body.push(l);
  }
  const head = body[0];
  if (!head || HEADER.some((h, i) => (head[i] ?? "").trim() !== h)) return { ok: false, error: "CSVの形式が想定と違います（見出しが一致しません）。取り込みを中止しました" };
  const rows: MarketRow[] = [];
  let skipped = 0;
  for (const r of body.slice(1)) {
    const price = Number((r[9] ?? "").replace(/[,¥円\s]/g, ""));
    const kind = r[3] === "sell" ? "sell" : r[3] === "buy" ? "buy" : null;
    if (r.length < HEADER.length || !kind || !Number.isFinite(price) || price <= 0) {
      skipped++;
      continue;
    }
    rows.push({ shopKey: r[0], shop: r[1], type: r[2], kind, set: r[4].trim(), no: r[5].trim(), name: r[6].trim(), rarity: r[7].trim(), condition: r[8].trim(), price: Math.round(price), inStock: r[10].trim() !== "0", url: r[11].trim(), scrapedAt: r[12].trim() });
  }
  if (rows.length < 100) return { ok: false, error: `CSVの行数が少なすぎます（${rows.length}行）。取り込みを中止しました` };
  return { ok: true, value: { updatedAt, rows, skipped } };
}

// ---------------------------------------------------------------- 照合
const nfkc = (s: string) => s.normalize("NFKC").trim();
export const setKey = (s: string) => nfkc(s).replace(/\s+/g, "").toUpperCase();
export const noKey = (s: string) => nfkc(s).replace(/\s+/g, "").toUpperCase();
export const nameKey = (s: string) => nfkc(s).replace(/\s+/g, "").toLowerCase();
const rarityKey = (s: string) => nfkc(s).replace(/\s+/g, "").toUpperCase();

export interface CardIdentity {
  setCode: string;
  cardNumber: string;
  rarity: string;
  name: string;
}

export interface MarketIndex {
  bySetNo: Map<string, MarketRow[]>;
}
export function buildIndex(rows: MarketRow[]): MarketIndex {
  const bySetNo = new Map<string, MarketRow[]>();
  for (const r of rows) {
    if (r.type !== "single" || !r.set || !r.no) continue;
    const k = `${setKey(r.set)}|${noKey(r.no)}`;
    const a = bySetNo.get(k);
    if (a) a.push(r);
    else bySetNo.set(k, [r]);
  }
  return { bySetNo };
}

export interface Variant {
  /** 候補の識別（名称の正規化キー） */
  key: string;
  name: string;
  rarity: string;
  rows: MarketRow[];
}
export type MatchResult =
  | { status: "matched"; variant: Variant }
  | { status: "ambiguous"; variants: Variant[]; reason: string }
  | { status: "unlisted" }
  | { status: "insufficient"; reason: string };

/**
 * カードとCSVの照合。収録弾＋カード番号が一致する行だけを候補にし、レアリティ・名称で絞る。
 * 1つに絞れなければ「照合未確定」（価格を確定しない）。利用者が選んだ名称キー（linkKey）があればそれを使う。
 */
export function matchCard(card: CardIdentity, index: MarketIndex, linkKey?: string | null): MatchResult {
  if (!card.setCode.trim() || !card.cardNumber.trim()) return { status: "insufficient", reason: "収録弾またはカード番号が未登録です" };
  const rows = index.bySetNo.get(`${setKey(card.setCode)}|${noKey(card.cardNumber)}`);
  if (!rows || rows.length === 0) return { status: "unlisted" };
  const groups = new Map<string, Variant>();
  for (const r of rows) {
    const k = `${rarityKey(r.rarity)}|${nameKey(r.name)}`;
    const g = groups.get(k);
    if (g) g.rows.push(r);
    else groups.set(k, { key: k, name: r.name, rarity: r.rarity, rows: [r] });
  }
  let cands = [...groups.values()];
  if (linkKey) {
    const hit = cands.find((v) => v.key === linkKey);
    if (hit) return { status: "matched", variant: hit };
  }
  if (card.rarity.trim()) {
    const rk = rarityKey(card.rarity);
    const byRarity = cands.filter((v) => rarityKey(v.rarity) === rk);
    if (byRarity.length === 0) return { status: "ambiguous", variants: cands, reason: "レアリティが一致する候補がありません" };
    cands = byRarity;
  }
  if (cands.length === 1) return { status: "matched", variant: cands[0] };
  const nk = nameKey(card.name);
  const byName = cands.filter((v) => nameKey(v.name) === nk);
  if (byName.length === 1) return { status: "matched", variant: byName[0] };
  return { status: "ambiguous", variants: cands, reason: "同じ番号に複数の候補があります（特殊仕様など）" };
}

// ---------------------------------------------------------------- 集計
export interface PriceStat {
  medianYen: number;
  lowYen: number;
  highYen: number;
  /** 集計に使った件数（外れ値・売切・対象外の状態は含めない） */
  samples: number;
  /** 外れ値として集計から外した件数 */
  outliers: number;
  /** 売切・状態違いなど、集計に使わなかった件数 */
  excluded: number;
  shops: { shop: string; price: number; condition: string; url: string; scrapedAt: string }[];
}

/** 販売価格に使う状態（店舗の標準・状態A・状態A-）。B/C・中古・未開封などは混ぜない */
const SELL_CONDITIONS = new Set(["", "状態A", "状態A-"]);
/** 買取価格に使う状態（シングルは通常、状態の記載なし） */
const BUY_CONDITIONS = new Set(["", "状態A", "状態A-"]);
/** 状態別の販売相場（Stage 6K）。CSVに状態B・状態Cの掲載があるときだけ、実際の相場として別に集計する（無ければ作らない） */
const GRADE_SELL_CONDITIONS: Record<"B" | "C", Set<string>> = { B: new Set(["状態B"]), C: new Set(["状態C"]) };

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * 販売・買取を別々に集計する。販売は「在庫あり」かつ対象の状態だけ。同じ店舗の複数行は最も安い（販売）／最も高い（買取）1件。
 * 参考価格は中央値。最安販売価格・最高買取価格も返す。3件以上で中央値の5倍超／5分の1未満は外れ値として集計から外す（機械的に採用しない）。
 */
export function aggregate(rows: MarketRow[], kind: "sell" | "buy", grade: "A" | "B" | "C" = "A"): PriceStat | null {
  const okCond = grade !== "A" ? GRADE_SELL_CONDITIONS[grade] : kind === "sell" ? SELL_CONDITIONS : BUY_CONDITIONS;
  if (grade !== "A" && kind !== "sell") return null;
  const mine = rows.filter((r) => r.kind === kind);
  const usable = mine.filter((r) => (kind === "buy" || r.inStock) && okCond.has(r.condition) && !/中古/.test(r.condition));
  // 店舗ごとに1件（販売=最安／買取=最高）
  const perShop = new Map<string, MarketRow>();
  for (const r of usable) {
    const cur = perShop.get(r.shopKey);
    if (!cur || (kind === "sell" ? r.price < cur.price : r.price > cur.price)) perShop.set(r.shopKey, r);
  }
  let picked = [...perShop.values()];
  if (picked.length === 0) return null;
  let outliers = 0;
  if (picked.length >= 3) {
    const m = median(picked.map((r) => r.price));
    const kept = picked.filter((r) => r.price <= m * 5 && r.price >= m / 5);
    outliers = picked.length - kept.length;
    if (kept.length > 0) picked = kept;
  }
  const prices = picked.map((r) => r.price);
  return {
    medianYen: median(prices),
    lowYen: Math.min(...prices),
    highYen: Math.max(...prices),
    samples: picked.length,
    outliers,
    excluded: mine.length - usable.length,
    shops: picked.map((r) => ({ shop: r.shop, price: r.price, condition: r.condition, url: r.url, scrapedAt: r.scrapedAt })).sort((a, b) => (kind === "sell" ? a.price - b.price : b.price - a.price)),
  };
}

// ---------------------------------------------------------------- 一括更新
export interface CardForMarket extends CardIdentity {
  id: string;
}
export interface CardMarketResult {
  cardId: string;
  status: "updated" | "unlisted" | "ambiguous" | "insufficient" | "no_price";
  reason?: string;
  sale: PriceStat | null;
  buyback: PriceStat | null;
  /** 状態B・Cの実際の販売相場（CSVに掲載があるときだけ） */
  saleGrades?: Partial<Record<"B" | "C", PriceStat>>;
  matchKey?: string;
  variants?: { key: string; name: string; rarity: string }[];
}
export interface MarketSummary {
  total: number;
  updated: number;
  unlisted: number;
  ambiguous: number;
  insufficient: number;
  noPrice: number;
}

/** コレクション内の全カードを1回のCSVで照合・集計する（カード1枚ごとの取得はしない）。同じカードの複数所有は1カードとして1回だけ */
export function computeMarket(cards: CardForMarket[], csv: ParsedCsv, links: Record<string, string> = {}): { results: CardMarketResult[]; summary: MarketSummary } {
  const index = buildIndex(csv.rows);
  const seen = new Set<string>();
  const results: CardMarketResult[] = [];
  for (const c of cards) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const m = matchCard(c, index, links[c.id]);
    if (m.status === "matched") {
      const sale = aggregate(m.variant.rows, "sell");
      const buyback = aggregate(m.variant.rows, "buy");
      const saleGrades: CardMarketResult["saleGrades"] = {};
      for (const g of ["B", "C"] as const) {
        const s = aggregate(m.variant.rows, "sell", g);
        if (s) saleGrades[g] = s;
      }
      results.push(sale || buyback ? { cardId: c.id, status: "updated", sale, buyback, saleGrades, matchKey: m.variant.key } : { cardId: c.id, status: "no_price", reason: "掲載はありますが、売切・対象外の状態のみで集計できる価格がありません", sale: null, buyback: null, matchKey: m.variant.key });
    } else if (m.status === "ambiguous") results.push({ cardId: c.id, status: "ambiguous", reason: m.reason, sale: null, buyback: null, variants: m.variants.map((v) => ({ key: v.key, name: v.name, rarity: v.rarity })) });
    else if (m.status === "insufficient") results.push({ cardId: c.id, status: "insufficient", reason: m.reason, sale: null, buyback: null });
    else results.push({ cardId: c.id, status: "unlisted", sale: null, buyback: null });
  }
  const n = (s: CardMarketResult["status"]) => results.filter((r) => r.status === s).length;
  return { results, summary: { total: results.length, updated: n("updated"), unlisted: n("unlisted"), ambiguous: n("ambiguous"), insufficient: n("insufficient"), noPrice: n("no_price") } };
}
