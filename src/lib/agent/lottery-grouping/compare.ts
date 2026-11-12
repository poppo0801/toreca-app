/**
 * 抽選どうしの比較（Stage 8F）。事実の突き合わせだけを行う純粋な関数。判断（自動・提案・単独）は verify.ts が行う。
 */
import type { FlexibleDate } from "@/types/domain";
import type { Cmp, GLottery, PairCompare } from "@/lib/agent/lottery-grouping/types";

export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** UTC の ISO 文字列を JST の暦日にする */
function jstDay(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
const dayOf = (f: FlexibleDate): string | null => (f.precision === "date_only" ? f.date : f.precision === "date_time" ? jstDay(f.at) : null);

/** 日時の比較。不明が含まれれば unknown。時刻まで分かっている同士は時刻まで比べる（暦日だけの側があれば暦日で比べる） */
export function cmpFlex(a: FlexibleDate, b: FlexibleDate): Cmp {
  if (a.precision === "unknown" || b.precision === "unknown") return "unknown";
  if (a.precision === "date_time" && b.precision === "date_time") return new Date(a.at).getTime() === new Date(b.at).getTime() ? "same" : "differs";
  const da = dayOf(a);
  const db = dayOf(b);
  return da && db && da === db ? "same" : "differs";
}

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[\s　、。，．・,.:;！!？?「」『』（）()【】\[\]―ー-]+/g, "");
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
/** 文章の類似度（2文字の並びの重なり。0〜1） */
export function textSimilarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  for (const g of bx) if (by.has(g)) inter++;
  return inter / (bx.size + by.size - inter);
}

function normUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}
/** URL の共有。トップページだけ（パスが無い）の一致は共有とみなさない */
export function sharedUrl(a: string[], b: string[]): boolean {
  const sb = new Set(b.map(normUrl));
  return a.some((u) => {
    const n = normUrl(u);
    return n.includes("/") && n.split("/").slice(1).join("/").length >= 4 && sb.has(n);
  });
}

function productRelation(a: GLottery, b: GLottery): PairCompare["products"] {
  const sa = new Set(a.items.map((i) => i.productId));
  const sb = new Set(b.items.map((i) => i.productId));
  if (sa.size === 0 || sb.size === 0) return "unknown";
  const inter = [...sa].filter((x) => sb.has(x)).length;
  if (inter === 0) return "disjoint";
  if (inter === sa.size && inter === sb.size) return "same";
  if (inter === sa.size || inter === sb.size) return "subset";
  return "overlap";
}
function quantityRelation(a: GLottery, b: GLottery): Cmp {
  if (a.items.length === 0 || b.items.length === 0) return "unknown";
  const m = (l: GLottery) => new Map(l.items.map((i) => [i.productId, `${i.quantity}${i.unit}`]));
  const ma = m(a);
  const mb = m(b);
  for (const [k, v] of ma) if (mb.has(k) && mb.get(k) !== v) return "differs";
  return "same";
}
const cmpStr = (a: string | null, b: string | null, unknown = "unknown"): Cmp => (!a || !b || a === unknown || b === unknown ? "unknown" : a === b ? "same" : "differs");

function requirementRelation(a: GLottery, b: GLottery): PairCompare["requirements"] {
  const ta = [...a.requirementTags].sort().join(",");
  const tb = [...b.requirementTags].sort().join(",");
  if (ta !== tb || (a.requirementLogic ?? "") !== (b.requirementLogic ?? "")) return "differs";
  const ca = norm(a.conditionsText);
  const cb = norm(b.conditionsText);
  if (ca === "" && cb === "") return "same";
  const sim = textSimilarity(a.conditionsText, b.conditionsText);
  return sim >= 0.85 ? "same" : sim >= 0.5 ? "similar" : "differs";
}

export function comparePair(a: GLottery, b: GLottery): PairCompare {
  return {
    a: a.id,
    b: b.id,
    chain: a.chainId === b.chainId ? "same" : "differs",
    store: a.storeId && b.storeId ? (a.storeId === b.storeId ? "same" : "distinct") : "unknown",
    products: productRelation(a, b),
    quantity: quantityRelation(a, b),
    applyStart: cmpFlex(a.applyStart, b.applyStart),
    applyDeadline: cmpFlex(a.applyDeadline, b.applyDeadline),
    resultDate: cmpFlex(a.resultDate, b.resultDate),
    applyMethod: cmpStr(a.applyMethod, b.applyMethod),
    receiveMethod: cmpStr(a.receiveMethod, b.receiveMethod),
    kind: cmpStr(a.kind ?? "normal", b.kind ?? "normal", ""),
    storeMode: (a.storeMode ?? "fixed") === (b.storeMode ?? "fixed") ? "same" : "differs",
    requirements: requirementRelation(a, b),
    campaign: a.campaignId && b.campaignId ? (a.campaignId === b.campaignId ? "same" : "differs") : "none",
    sharedSourceUrl: sharedUrl(a.sourceUrls, b.sourceUrls),
  };
}

/** 事前の絞り込み（AIを呼ぶ前の固定ロジック）: 比較する価値のある相手か。同じ系列で、店舗が別で、対象商品が重なる抽選だけ */
export function isPlausiblePeer(subject: GLottery, other: GLottery): boolean {
  if (other.archived || other.id === subject.id || other.chainId !== subject.chainId) return false;
  if (subject.storeId && other.storeId && subject.storeId === other.storeId) return false;
  const p = productRelation(subject, other);
  return p === "same" || p === "subset" || p === "overlap" || p === "unknown" || comparePair(subject, other).campaign === "same";
}
