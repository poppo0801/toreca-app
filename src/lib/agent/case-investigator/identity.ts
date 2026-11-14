/**
 * 同一抽選の照合（Stage 9H-1・純関数）。調査で見つけたページが「いま調べている抽選」と同じ企画かを、構造化した材料で判定する。
 * 別の抽選（別の商品・別の回・別の店舗）の情報を、同じ商品名だけで混ぜない。決めるのはAIではなく、この固定ロジック。
 *   same      : 系列または商品が一致し、食い違う材料がない → 統合してよい
 *   different : 商品・系列・店舗・応募期間（別の回）のどれかが明確に違う → 混ぜない
 *   unknown   : 一致を裏づける材料が足りない → 統合せず、保留（隔離）にする
 */
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { productKey } from "@/lib/lottery-match";
import { normName } from "@/lib/norm";
import { relateDateTimes } from "@/lib/collector/date-phrases";

export interface IdentityFacts {
  chain?: string;
  store?: string;
  /** 応募時に店舗を選ぶ（店舗不明とは別） */
  storeSelect?: boolean;
  products?: string[];
  /** YYYY-MM-DD（時刻があれば "YYYY-MM-DD HH:MM"） */
  applyStart?: string;
  applyDeadline?: string;
}
export type IdentityVerdict = "same" | "different" | "unknown";
export interface IdentityResult {
  verdict: IdentityVerdict;
  matched: string[];
  mismatched: string[];
}

/** 別の回とみなす応募締切の差（日） */
export const OTHER_ROUND_DAYS = 14;

const splitDt = (s?: string): { date: string; time: string } | null => {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/.exec((s ?? "").trim());
  return m ? { date: m[1], time: m[2] ?? "" } : null;
};
const prodKeys = (p?: string[]): string[] => (p ?? []).map((x) => productKey(x)).filter(Boolean);
const overlap = (a: string[], b: string[]): boolean => a.some((x) => b.some((y) => x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)))));

export function matchIdentity(target: IdentityFacts, page: IdentityFacts): IdentityResult {
  const matched: string[] = [];
  const mismatched: string[] = [];
  // 系列
  const tc = target.chain ? chainCanonicalKey(target.chain) : "";
  const pc = page.chain ? chainCanonicalKey(page.chain) : "";
  if (tc && pc) (tc === pc || tc.includes(pc) || pc.includes(tc) ? matched : mismatched).push("系列");
  // 商品
  const tp = prodKeys(target.products);
  const pp = prodKeys(page.products);
  if (tp.length && pp.length) (overlap(tp, pp) ? matched : mismatched).push("商品");
  // 店舗: 特定の店舗どうしが違うときだけ不一致（店舗選択式・店舗不明は比較しない）
  if (target.store && page.store && !target.storeSelect && !page.storeSelect) {
    const a = normName(target.store);
    const b = normName(page.store);
    if (a && b) (a === b || a.includes(b) || b.includes(a) ? matched : mismatched).push("店舗");
  }
  // 応募期間: 応募締切の差が大きければ別の回。境界表現・日付のみ/時刻つきは同じとみなす
  const td = splitDt(target.applyDeadline);
  const pd = splitDt(page.applyDeadline);
  if (td && pd) {
    const rel = relateDateTimes(td, pd);
    const gap = Math.abs(Date.parse(td.date) - Date.parse(pd.date)) / 86_400_000;
    if (rel.same) matched.push("応募締切");
    else if (gap > OTHER_ROUND_DAYS) mismatched.push("応募期間（別の回の可能性）");
  }
  if (mismatched.length) return { verdict: "different", matched, mismatched };
  // 一致の裏づけ: 系列が一致している、または（系列を比べられないときは）商品が一致し、かつ応募締切か店舗も一致していること。
  // 商品名だけの一致は、同じ商品を扱う別の店舗・別の回の抽選を混ぜる原因になる（9H-2の評価で、系列が不明な案件に別の店舗の告知が統合された）ため、同一とは認めず保留にする
  if (matched.includes("系列")) return { verdict: "same", matched, mismatched };
  if (matched.includes("商品") && (matched.includes("応募締切") || matched.includes("店舗"))) return { verdict: "same", matched, mismatched };
  return { verdict: "unknown", matched, mismatched };
}
