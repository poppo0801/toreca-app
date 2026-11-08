/**
 * BOXの相場取得（Stage 7F・純関数）。カード相場と同じ公開CSV（type=box の行）を使い、トレマネの商品マスターと照合して価格を集計する。
 * 方針:
 *  - CSVのBOX行には収録弾コード・番号の列が無く、名称も店舗ごとに違う。名称の一部が一致しただけでは自動で確定しない。
 *  - 照合の順序: ①商品コード（名称内の「(M1S)」など括弧つきの一致） → ②商品名の一致（飾りの語を除いた後の完全一致） → ③別名の一致
 *    ④部分一致・類似は「候補」として利用者に示すだけ（利用者が選んだ対応は box_market_links に保存して次回以降も使う）。
 *  - 限定版・セット・デラックス等の語がCSV側だけにあるときは、一致していても自動で確定しない（別商品の可能性）。
 *  - シュリンクの有無がCSVに明示されたものだけ shrink / no_shrink の実価格にする。「未開封」「新品」は有無を断定しない基準（base）、
 *    「状態A-」など傷み・中古を示すものは集計に使わない。
 */
import { aggregateWith, type MarketRow, type PriceStat } from "@/lib/market-price";

export type BoxBasis = "base" | "shrink" | "no_shrink";
export type BoxMatchMethod = "code" | "name" | "alias" | "manual";
export const BOX_BASIS_LABEL: Record<BoxBasis, string> = { base: "未開封（状態の指定なし）", shrink: "シュリンクあり", no_shrink: "シュリンクなし" };
export const BOX_METHOD_LABEL: Record<BoxMatchMethod, string> = { code: "商品コード", name: "商品名", alias: "別名", manual: "手動で確定" };

const nfkc = (s: string) => s.normalize("NFKC").trim();

/** CSVの商品名の正規化キー（空白・記号を除く）。利用者が確定した対応の保存にも使う */
export function boxKey(s: string): string {
  return nfkc(s)
    .toLowerCase()
    .replace(/[\s・、。,.'"“”‘’「」『』【】[\]()（）〈〉<>!！?？~〜～:：;；/／_\-‐–—]/g, "");
}

/**
 * 店舗が付ける飾りの語。名称の先頭のシリーズ名・パックの種類と、末尾の「BOX」「未開封」だけを除く。
 * 名称の途中や末尾にあるシリーズ名（例:「プレミアムトレーナーボックス ソード＆シールド」）は商品の違いを表すので除かない。
 * 限定版・セット・デラックス等も除かない。
 */
const SERIES: Record<string, string> = { mega: "mega", "スカーレット&バイオレット": "sv", スカーレットバイオレット: "sv", "ソード&シールド": "swsh", "サン&ムーン": "sm" };
const LEAD = ["ポケモンカードゲーム", "ポケモンカード", "ポケカ", "強化拡張パック", "拡張パック", "ハイクラスパック", ...Object.keys(SERIES)].map(boxKey).sort((a, b) => b.length - a.length);
const SERIES_BY_KEY = new Map(Object.entries(SERIES).map(([k, v]) => [boxKey(k), v]));
const TRAIL = ["未開封box", "box", "未開封", "新品"].map(boxKey).sort((a, b) => b.length - a.length);

/** 括弧つきの商品コード「(M1S)」「[SV11B-D]」を取り出す（大文字） */
export function extractCodes(name: string): string[] {
  const out: string[] = [];
  for (const m of nfkc(name).matchAll(/[(（[【]\s*([A-Za-z0-9-]{2,14})\s*[)）\]】]/g)) out.push(m[1].toUpperCase());
  return out;
}

/** 照合に使う名称（コード括弧と、先頭・末尾の飾りの語を除いたキー）と、先頭のシリーズ名（mega / sv / swsh / sm。無ければ空） */
export function boxParts(name: string): { core: string; series: string } {
  let s = boxKey(nfkc(name).replace(/[(（[【]\s*[A-Za-z0-9-]{2,14}\s*[)）\]】]/g, " "));
  let series = "";
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of LEAD) {
      if (d && s.startsWith(d) && s.length > d.length) {
        s = s.slice(d.length);
        series = SERIES_BY_KEY.get(d) ?? series;
        changed = true;
        break;
      }
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of TRAIL) {
      if (t && s.endsWith(t) && s.length > t.length) {
        s = s.slice(0, -t.length);
        changed = true;
        break;
      }
    }
  }
  return { core: s, series };
}
export const boxCore = (name: string): string => boxParts(name).core;
/** シリーズ名が両方にあって食い違うときは別商品 */
const seriesOk = (a: string, b: string) => !a || !b || a === b;

/** 別商品（限定版・セット等）を示す語。CSV側だけにあるときは自動で確定しない */
const VARIANT_MARKERS = ["ポケモンセンター", "ポケセン", "限定", "セット", "デラックス", "スペシャル", "プレミアム", "ファイル", "コレクション", "ジャンボ", "カートン", "ケース", "まとめ", "プロモ", "特典", "サプライ", "スリーブ", "スターター"].map(boxKey);
export function variantMarkers(name: string): string[] {
  const k = boxKey(name);
  return VARIANT_MARKERS.filter((m) => k.includes(m));
}

/** 状態の記載 → 価格の根拠。傷み・中古など集計に使えないものは null */
export function classifyBoxCondition(condition: string): BoxBasis | null {
  const c = nfkc(condition);
  if (/ノーシュリンク|シュリンク.*(なし|無|ナシ)/.test(c)) return "no_shrink";
  if (/シュリンク.*(付|あり|有)/.test(c)) return "shrink";
  if (c === "" || c === "未開封" || c === "新品") return "base";
  return null;
}

export interface BoxProductIdentity {
  id: string;
  name: string;
  code: string | null;
  aliases: string[];
}

export interface BoxCsvGroup {
  key: string;
  /** CSVに出てくる表記（重複なし） */
  names: string[];
  core: string;
  series: string;
  codes: string[];
  rows: MarketRow[];
}

/** CSVのBOX行を、正規化した商品名ごとにまとめる */
export function buildBoxGroups(rows: MarketRow[]): Map<string, BoxCsvGroup> {
  const m = new Map<string, BoxCsvGroup>();
  for (const r of rows) {
    if (r.type !== "box" || !r.name.trim()) continue;
    const k = boxKey(r.name);
    if (!k) continue;
    const bp = boxParts(r.name);
    const g = m.get(k) ?? { key: k, names: [], core: bp.core, series: bp.series, codes: [], rows: [] };
    if (!g.names.includes(r.name)) g.names.push(r.name);
    for (const c of extractCodes(r.name)) if (!g.codes.includes(c)) g.codes.push(c);
    g.rows.push(r);
    m.set(k, g);
  }
  return m;
}

export interface BoxPriceEntry {
  kind: "sale" | "buyback";
  basis: BoxBasis;
  stat: PriceStat;
}

/** グループの行から、販売・買取×根拠ごとに集計する */
export function aggregateBox(rows: MarketRow[]): BoxPriceEntry[] {
  const out: BoxPriceEntry[] = [];
  for (const [kind, k] of [["sale", "sell"], ["buyback", "buy"]] as const) {
    for (const basis of ["base", "shrink", "no_shrink"] as const) {
      const stat = aggregateWith(rows, k, (c) => classifyBoxCondition(c) === basis);
      if (stat) out.push({ kind, basis, stat });
    }
  }
  return out;
}

export type BoxStatus = "updated" | "unlisted" | "ambiguous" | "no_price";
export interface BoxCandidate {
  key: string;
  name: string;
  names: string[];
  shops: number;
  saleYen: number | null;
  buybackYen: number | null;
  reason: string;
}
export interface BoxMarketResult {
  productId: string;
  status: BoxStatus;
  reason: string;
  method: BoxMatchMethod | null;
  keys: string[];
  prices: BoxPriceEntry[];
  candidates: BoxCandidate[];
}
export interface BoxMarketSummary {
  /** 照合の対象にした商品数 */
  total: number;
  /** 自動で確定できた商品数（コード・名称・別名） */
  autoMatched: number;
  /** 利用者が確定済みの対応で照合できた商品数 */
  linkMatched: number;
  /** 価格を保存できた商品数 */
  priced: number;
  salePriced: number;
  buybackPriced: number;
  /** 手動で確認する候補がある商品数（確認の対象に絞ったもの） */
  needsReview: number;
  unlisted: number;
  noPrice: number;
  /** 保存した対応のうち、今のCSVに見つからないもの（再確認が必要） */
  staleLinks: number;
  csvBoxRows: number;
  csvBoxNames: number;
}

/** 買取（基準）が販売（基準）のこの倍率を超えるときは、照合の誤りを疑う */
export const ANOMALY_RATIO = 1.2;
const METHOD_RANK: Record<BoxMatchMethod, number> = { manual: 0, code: 1, name: 2, alias: 3 };

/**
 * 商品マスターとCSVのBOXを照合し、価格を集計する。
 * links: 利用者が確定した対応（CSV名キー → 商品ID）。reviewIds: 候補の確認を求める商品（BOXコレクションにある商品など）。
 */
export function computeBoxMarket(
  products: BoxProductIdentity[],
  rows: MarketRow[],
  links: Record<string, string> = {},
  reviewIds: ReadonlySet<string> = new Set(),
): { results: BoxMarketResult[]; summary: BoxMarketSummary } {
  const groups = buildBoxGroups(rows);
  const assigned = new Map<string, { productId: string; method: BoxMatchMethod }>();
  const blocked = new Map<string, string>(); // 自動確定を見送ったグループ → 理由
  const byId = new Map(products.map((p) => [p.id, p]));
  let staleLinks = 0;

  // ① 利用者が確定した対応が最優先
  for (const [key, pid] of Object.entries(links)) {
    if (!byId.has(pid)) continue;
    if (groups.has(key)) assigned.set(key, { productId: pid, method: "manual" });
    else staleLinks++;
  }

  // ②〜③ 自動の照合（コード → 商品名 → 別名）。複数の商品に当てはまるときは確定しない
  const coreOf = new Map(
    products.map((p) => {
      const bp = boxParts(p.name);
      return [p.id, { name: bp.core, series: bp.series, aliases: p.aliases.map(boxParts).filter((x) => x.core), key: boxKey(p.name), code: (p.code ?? "").trim().toUpperCase() }] as const;
    }),
  );
  for (const g of groups.values()) {
    if (assigned.has(g.key)) continue;
    const hits: { productId: string; method: BoxMatchMethod }[] = [];
    for (const p of products) {
      const c = coreOf.get(p.id)!;
      let method: BoxMatchMethod | null = null;
      if (c.code && g.codes.includes(c.code)) method = "code";
      else if (c.name && g.core === c.name && seriesOk(g.series, c.series)) method = "name";
      else if (g.core && c.aliases.some((a) => a.core === g.core && seriesOk(g.series, a.series))) method = "alias";
      if (!method) continue;
      // 限定版・セット等の語がCSV側だけにあるときは別商品の可能性があるので自動で確定しない
      const extra = variantMarkers(g.names[0]).filter((m) => !c.key.includes(m));
      if (extra.length > 0) {
        blocked.set(g.key, `「${extra.join("・")}」を含むため、通常版と別の商品の可能性があります`);
        continue;
      }
      hits.push({ productId: p.id, method });
    }
    const distinct = new Set(hits.map((h) => h.productId));
    if (distinct.size === 1) assigned.set(g.key, hits.sort((a, b) => METHOD_RANK[a.method] - METHOD_RANK[b.method])[0]);
    else if (distinct.size > 1) blocked.set(g.key, "複数の商品に当てはまるため確定できません");
  }

  const keysOf = new Map<string, { key: string; method: BoxMatchMethod }[]>();
  for (const [key, a] of assigned) keysOf.set(a.productId, [...(keysOf.get(a.productId) ?? []), { key, method: a.method }]);

  const summary: BoxMarketSummary = { total: products.length, autoMatched: 0, linkMatched: 0, priced: 0, salePriced: 0, buybackPriced: 0, needsReview: 0, unlisted: 0, noPrice: 0, staleLinks, csvBoxRows: rows.filter((r) => r.type === "box").length, csvBoxNames: groups.size };
  const results: BoxMarketResult[] = [];
  for (const p of products) {
    const ks = keysOf.get(p.id) ?? [];
    if (ks.length > 0) {
      const method = ks.map((k) => k.method).sort((a, b) => METHOD_RANK[a] - METHOD_RANK[b])[0];
      if (method === "manual") summary.linkMatched++;
      else summary.autoMatched++;
      const prices = aggregateBox(ks.flatMap((k) => groups.get(k.key)!.rows));
      if (prices.length === 0) {
        summary.noPrice++;
        results.push({ productId: p.id, status: "no_price", reason: "掲載はありますが、売切・対象外の状態のみで集計できる価格がありません", method, keys: ks.map((k) => k.key), prices: [], candidates: [] });
        continue;
      }
      // 自動で照合した結果、買取が販売を大きく上回るときは別の商品を拾っている可能性が高いので確定しない（利用者が確認する）
      const sBase = prices.find((x) => x.kind === "sale" && x.basis === "base")?.stat.medianYen;
      const bBase = prices.find((x) => x.kind === "buyback" && x.basis === "base")?.stat.medianYen;
      if (method !== "manual" && sBase && bBase && bBase > sBase * ANOMALY_RATIO) {
        summary.autoMatched--;
        summary.needsReview++;
        const cands = ks.slice(0, 6).map((k) => {
          const g = groups.get(k.key)!;
          const pr = aggregateBox(g.rows);
          const pick = (kind: "sale" | "buyback") => pr.find((x) => x.kind === kind && x.basis === "base")?.stat;
          return { key: k.key, name: g.names[0], names: g.names, shops: new Set(g.rows.map((r) => r.shopKey)).size, saleYen: pick("sale")?.medianYen ?? null, buybackYen: pick("buyback")?.medianYen ?? null, reason: "買取価格が販売価格を大きく上回っています。同じ商品か確認してください" };
        });
        results.push({ productId: p.id, status: "ambiguous", reason: "買取価格が販売価格を大きく上回っているため、照合が正しいか確認してください", method: null, keys: [], prices: [], candidates: cands });
        continue;
      }
      summary.priced++;
      if (prices.some((x) => x.kind === "sale")) summary.salePriced++;
      if (prices.some((x) => x.kind === "buyback")) summary.buybackPriced++;
      results.push({ productId: p.id, status: "updated", reason: "", method, keys: ks.map((k) => k.key), prices, candidates: [] });
      continue;
    }
    // 未確定: 候補の抽出（確認の対象にする商品だけ）
    const c = coreOf.get(p.id)!;
    const candidates: BoxCandidate[] = [];
    if (reviewIds.has(p.id) && c.name.length >= 3) {
      for (const g of groups.values()) {
        if (assigned.has(g.key)) continue;
        const contains = g.core.includes(c.name) || (g.core.length >= 4 && c.name.includes(g.core));
        const codeHit = !!c.code && g.codes.includes(c.code);
        if (!contains && !codeHit) continue;
        const pr = aggregateBox(g.rows);
        const pick = (kind: "sale" | "buyback") => (pr.find((x) => x.kind === kind && x.basis === "base") ?? pr.find((x) => x.kind === kind))?.stat;
        const reason = blocked.get(g.key) ?? (codeHit ? "商品コードが一致しますが、限定版・セット等の可能性があります" : "商品名の一部が一致します（完全一致ではありません）");
        candidates.push({ key: g.key, name: g.names[0], names: g.names, shops: new Set(g.rows.map((r) => r.shopKey)).size, saleYen: pick("sale")?.medianYen ?? null, buybackYen: pick("buyback")?.medianYen ?? null, reason });
      }
      candidates.sort((a, b) => b.shops - a.shops || a.name.localeCompare(b.name, "ja"));
    }
    const limited = candidates.slice(0, 6);
    if (limited.length > 0) {
      summary.needsReview++;
      results.push({ productId: p.id, status: "ambiguous", reason: "候補があります。通常のBOXと同じ商品か確認してください", method: null, keys: [], prices: [], candidates: limited });
    } else {
      summary.unlisted++;
      results.push({ productId: p.id, status: "unlisted", reason: "CSVに該当する商品がありません", method: null, keys: [], prices: [], candidates: [] });
    }
  }
  return { results, summary };
}
