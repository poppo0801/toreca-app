/**
 * 照合のための正規化（Stage 10N・純関数）。系列の別名・店舗名・商品名・日付・URL を、表記の違いを吸収して比べられる形にする。
 * 既存の部品を再利用: 系列＝`chain-normalize`、商品＝`lottery-match`、名称＝`norm`。**固定の例外規則（特定の系列名など）は積まない**。
 */
import { chainCanonicalKey, sameChainName } from "@/lib/chain-normalize";
import { dice, productKey } from "@/lib/lottery-match";
import { normName } from "@/lib/norm";
import { prefectureFromStoreName } from "@/lib/collector/conditions";

export type Tri = "same" | "different" | "unknown";

export const chainsMatch = (a: string | null | undefined, b: string | null | undefined): Tri => {
  if (!a?.trim() || !b?.trim()) return "unknown";
  return sameChainName(a, b) || chainCanonicalKey(a) === chainCanonicalKey(b) ? "same" : "different";
};

/** 店舗名の比較用キー: 括弧書き（最寄り駅など）・末尾の「店」を除く。通販・オンライン等の汎用の語だけの名前は空（店舗として使わない） */
export const storeKey = (s: string | null | undefined): string => {
  const k = normName((s ?? "").replace(/[(（][^)）]*[)）]/g, "")).replace(/店$/, "");
  return /^(通販|オンライン|ネット|公式|全店|各店|応募時に店舗選択|店舗選択)/.test(k) ? "" : k;
};

export type StoreMatch = "same" | "partial" | "different" | "unknown";
/** 店舗の一致: 正規化が同じ=same／一方が他方を含む（短い方が4文字以上）=partial（同じ店舗の別表記の可能性。強い根拠にはしない）／それ以外の両方あり=different */
export function storesMatch(a: string | null | undefined, b: string | null | undefined): StoreMatch {
  const x = storeKey(a);
  const y = storeKey(b);
  if (!x || !y) return "unknown";
  if (x === y) return "same";
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 4 && l.includes(s) ? "partial" : "different";
}

export type ProductMatch = "same" | "overlap" | "disjoint" | "unknown";
/** 商品の一致: 全ての商品が対応=same／一部が対応=overlap／対応するものが無い=disjoint。商品名は照合キーと文字の近さ（Dice）で比べる */
export function productsMatch(a: string[] | null | undefined, b: string[] | null | undefined): ProductMatch {
  const x = (a ?? []).map(productKey).filter(Boolean);
  const y = (b ?? []).map(productKey).filter(Boolean);
  if (!x.length || !y.length) return "unknown";
  const near = (p: string, q: string): boolean => p === q || (Math.min(p.length, q.length) >= 4 && (p.includes(q) || q.includes(p))) || dice(p, q) >= 0.8;
  const hitsA = x.filter((p) => y.some((q) => near(p, q))).length;
  const hitsB = y.filter((q) => x.some((p) => near(p, q))).length;
  if (!hitsA && !hitsB) return "disjoint";
  return hitsA === x.length && hitsB === y.length ? "same" : "overlap";
}

export interface ParsedDate {
  year: number | null;
  month: number;
  day: number;
  hour: number | null;
  minute: number | null;
}
const z = (s: string): string => s.normalize("NFKC");
/** 日付の表記（2026-11-22 23:59／11/22(日)23:59／11月22日／11/22 など）を読む。読めなければ null。年が無いときは null（比較は月日で行う） */
export function parseDate(raw: string | null | undefined): ParsedDate | null {
  if (!raw) return null;
  const s = z(raw);
  let m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[T\s　]*(\d{1,2}):(\d{2}))?/.exec(s);
  if (m) return { year: +m[1], month: +m[2], day: +m[3], hour: m[4] ? +m[4] : null, minute: m[5] ? +m[5] : null };
  m = /(\d{1,2})[/月](\d{1,2})日?(?:\([^)]{1,3}\))?[\s　]*(?:(\d{1,2}):(\d{2}))?/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) return { year: null, month: +m[1], day: +m[2], hour: m[3] ? +m[3] : null, minute: m[4] ? +m[4] : null };
  return null;
}
export type DateMatch = "same" | "near" | "different" | "unknown";
/** 日付の一致: 同じ日=same／1日違い=near（時刻の表記・日付またぎの揺れ）／それ以外=different。年が両方あれば年も比べる */
export function datesMatch(a: string | null | undefined, b: string | null | undefined): DateMatch {
  const x = parseDate(a);
  const y = parseDate(b);
  if (!x || !y) return "unknown";
  if (x.year != null && y.year != null && x.year !== y.year) return "different";
  const ord = (d: ParsedDate): number => d.month * 31 + d.day;
  const diff = Math.abs(ord(x) - ord(y));
  if (diff === 0) return "same";
  return diff === 1 ? "near" : "different";
}

export type UrlClass = "specific" | "generic" | "shortener" | "social" | "invalid";
export interface CanonUrl {
  key: string;
  host: string;
  cls: UrlClass;
}
const SHORTENER = /(^|\.)(t\.co|bit\.ly|amzn\.to|goo\.gl|tinyurl\.com|lin\.ee)$/;
const SOCIAL = /(^|\.)(x\.com|twitter\.com)$/;
const GENERIC_WORDS = /^(lottery|news|campaign|shop|index|apply|form|entry|pre-?order|information|info|topics?|event|events|store|stores|list|special)$/i;
/** URLの正規化と分類。**URLの一致だけで同じ抽選と決めない**: 汎用のページ（トップ・一覧・系列共通の案内）は generic、短縮URLは shortener（情報なし）、X投稿は social（出所の投稿であって応募先ではない） */
export function canonUrl(raw: string): CanonUrl {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { key: raw, host: "", cls: "invalid" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { key: raw, host: "", cls: "invalid" };
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|igshid|ref)/i.test(k)) u.searchParams.delete(k);
  const path = u.pathname.replace(/\/+$/, "");
  const key = `${host}${path}${u.search}`;
  if (SHORTENER.test(host)) return { key, host, cls: "shortener" };
  if (SOCIAL.test(host)) return { key, host, cls: /\/status\/\d+/.test(path) ? "social" : "generic" };
  const segs = path.split("/").filter(Boolean);
  const idLike = (s: string): boolean => /\d{4,}/.test(s) || /^[0-9a-f]{8,}$/i.test(s) || /^[A-Za-z0-9_-]{10,}$/.test(s);
  const specific = segs.some(idLike) || (segs.length >= 3 && !GENERIC_WORDS.test(segs[segs.length - 1])) || /[?&](id|event|e|item|no)=/i.test(u.search);
  return { key, host, cls: specific ? "specific" : "generic" };
}

export type UrlSupport = "specific_same" | "generic_same" | "different" | "none";
export function urlsSupport(a: string[] | undefined, b: string[] | undefined): UrlSupport {
  const x = (a ?? []).map(canonUrl).filter((c) => c.cls !== "invalid" && c.cls !== "shortener" && c.cls !== "social");
  const y = (b ?? []).map(canonUrl).filter((c) => c.cls !== "invalid" && c.cls !== "shortener" && c.cls !== "social");
  if (!x.length || !y.length) return "none";
  const ky = new Map(y.map((c) => [c.key, c]));
  const hit = x.find((c) => ky.has(c.key));
  if (hit) return hit.cls === "specific" ? "specific_same" : "generic_same";
  return "different";
}

/** 都道府県の読み取り: 明示された値を優先し、無ければ店舗名に含まれる明示的な地域名から（曖昧なら空） */
export function prefectureOf(explicit: string | null | undefined, store: string | null | undefined): string {
  const e = (explicit ?? "").trim();
  return e || prefectureFromStoreName(store ?? "");
}
