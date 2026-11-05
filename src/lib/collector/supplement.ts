/**
 * 同一抽選の照合と補足投稿の紐付け（Stage 6D・純関数）。Stage 6C の続報照合（matchTracked）を、確認待ち・保留中の候補全体へ広げたもの。
 *  - 同一抽選: 系列・商品が一致し、店舗は双方が分かっていれば一致。応募締切・応募開始が双方に分かっていて違うなら、別の抽選（関連候補）
 *  - 商品名と締切日だけの一致では統合しない。複数に該当するときは自動確定せず、関連候補として記録する
 *  - 補足投稿（応募条件・発表方法だけを説明し、商品や締切が無い投稿）: 引用元・返信元／共通の応募URL／同じ公式アカウント×同じ系列×近い時刻、のいずれかで
 *    対象が一意に特定できる場合だけ補完する。同じアカウントの投稿というだけでは統合しない
 */
import { chainKey, productKey, urlIdentity } from "@/lib/lottery-match";
import { normName } from "@/lib/norm";
import { applyUrlOf, type FieldMap, type FieldSource } from "@/lib/collector/fields";
import type { Summary } from "@/lib/collector/completeness";
import type { Tracking } from "@/lib/collector/tracking";
import type { LotteryInput } from "@/lib/lottery-input";

export interface OpenLite {
  id: string;
  input: LotteryInput;
  summary: Summary;
  fields: FieldMap;
  tracking?: Tracking | null;
  created_at: string;
  source: FieldSource;
  /** この候補のX投稿ID・引用元の投稿ID */
  postId?: string;
  quotedId?: string;
  /** 投稿者のアカウント（小文字） */
  account?: string;
  /** 投稿・応募の関連URL（情報源URL・応募URL） */
  urls: string[];
  /** 投稿日時（ISO。無ければ候補の作成日時） */
  postedAt: string;
}

const known = (f?: { precision: string; date?: string | null }) => !!f && f.precision !== "unknown" && !!f.date;
const nameKnown = (i: LotteryInput) => !!(i.chain.id || i.chain.name.trim());
const sameChain = (a: LotteryInput, b: LotteryInput) => (!!a.chain.id && a.chain.id === b.chain.id) || (!!a.chain.name.trim() && !!b.chain.name.trim() && chainKey(a.chain.name) === chainKey(b.chain.name));
const chainCompatible = (a: LotteryInput, b: LotteryInput) => !nameKnown(a) || !nameKnown(b) || sameChain(a, b);
const storeCompatible = (a: LotteryInput, b: LotteryInput) => {
  const x = a.store.name.trim();
  const y = b.store.name.trim();
  return !x || !y || (!!a.store.id && a.store.id === b.store.id) || normName(x) === normName(y);
};
const prodKeys = (i: LotteryInput) => new Set(i.items.map((x) => productKey(x.product.name)).filter((k) => k.length >= 3));
const prodIds = (i: LotteryInput) => new Set(i.items.map((x) => x.product.id).filter((x): x is string => !!x));
const sharesProduct = (a: LotteryInput, b: LotteryInput) => {
  const ids = prodIds(b);
  const keys = prodKeys(b);
  return a.items.some((i) => (!!i.product.id && ids.has(i.product.id)) || keys.has(productKey(i.product.name)));
};

export interface OpenMatch {
  /** 一意に同じ抽選と決められたもの */
  match: OpenLite | null;
  /** 決められない・別の抽選の可能性があるもの（関連候補として記録する） */
  related: string[];
}

/** 日付の食い違い（双方に分かっていて違う）。別の抽選の可能性が高い */
const datesDiffer = (a: LotteryInput, b: LotteryInput) => (known(a.applyDeadline) && known(b.applyDeadline) && a.applyDeadline.date !== b.applyDeadline.date) || (known(a.applyStart) && known(b.applyStart) && a.applyStart.date !== b.applyStart.date);

export function matchOpen(list: OpenLite[], next: LotteryInput, selfId: string): OpenMatch {
  const hits: OpenLite[] = [];
  const related: string[] = [];
  for (const o of list) {
    if (o.id === selfId) continue;
    if (!nameKnown(next) || !sameChain(o.input, next)) continue; // 系列が分からない・違うものは対象にしない
    if (!sharesProduct(o.input, next)) continue;
    if (!storeCompatible(o.input, next)) continue;
    // 追跡中の予告は日付が未確定・変更されうるので、日付の違いだけでは別の抽選としない（続報の更新として扱う）。それ以外は別の抽選回の可能性
    if (!o.tracking && datesDiffer(o.input, next)) {
      related.push(o.id); // 同じ系列・商品でも、日付が違う＝別の抽選回の可能性。統合せず関連候補に
      continue;
    }
    hits.push(o);
  }
  if (hits.length === 1) return { match: hits[0], related };
  return { match: null, related: [...related, ...hits.map((h) => h.id)] };
}

// ---------------------------------------------------------------- 補足投稿
export interface SupplementPost {
  input: LotteryInput;
  postId?: string;
  quotedId?: string;
  replyToId?: string;
  account?: string;
  postedAt: string;
  urls: string[];
}

/** 補足投稿か（商品も締切・開始も無く、応募条件・発表方法・応募方法などだけがある） */
export function isSupplement(i: LotteryInput): boolean {
  const noProduct = i.items.every((x) => !x.product.id && !x.product.name.trim());
  const noPeriod = !known(i.applyDeadline) && !known(i.applyStart);
  const hasInfo = !!(i.conditionsText?.trim() || (i.requirementTags ?? []).length > 0 || (i.announcementMethods ?? []).length > 0 || i.announcementMethod?.trim() || (i.applyMethod && i.applyMethod !== "unknown") || i.verificationText?.trim());
  return noProduct && noPeriod && hasInfo;
}

export type SupplementSignal = "quote" | "url" | "account";
export interface SupplementMatch {
  target: OpenLite | null;
  signal: SupplementSignal | null;
  related: string[];
}

const WINDOW_MS = 24 * 3600_000;
const idsOf = (o: OpenLite) => new Set([o.postId, o.quotedId].filter((x): x is string => !!x));
const urlKeys = (o: { urls: string[]; input?: LotteryInput }) => new Set([...o.urls, ...(o.input ? [applyUrlOf(o.input)] : [])].map((u) => (u ? urlIdentity(u) : null)).filter((k): k is string => !!k && !k.startsWith("url:t.co")));

export function matchSupplement(list: OpenLite[], sup: SupplementPost, selfId: string): SupplementMatch {
  const strong: { o: OpenLite; s: SupplementSignal }[] = [];
  const weak: OpenLite[] = [];
  const supIds = new Set([sup.quotedId, sup.replyToId].filter((x): x is string => !!x));
  const supUrls = urlKeys({ urls: sup.urls, input: sup.input });
  for (const o of list) {
    if (o.id === selfId) continue;
    if (!chainCompatible(o.input, sup.input)) continue;
    const oIds = idsOf(o);
    if ([...supIds].some((x) => oIds.has(x))) {
      strong.push({ o, s: "quote" });
      continue;
    }
    const oUrls = urlKeys(o);
    if ([...supUrls].some((k) => oUrls.has(k))) {
      strong.push({ o, s: "url" });
      continue;
    }
    // 同じ公式アカウント×同じ系列×近い時刻（アカウントだけでは統合しない。系列が双方に分かっていて一致すること）
    if (sup.account && o.account === sup.account && nameKnown(sup.input) && nameKnown(o.input) && sameChain(o.input, sup.input) && Math.abs(new Date(o.postedAt).getTime() - new Date(sup.postedAt).getTime()) <= WINDOW_MS) weak.push(o);
  }
  if (strong.length === 1) return { target: strong[0].o, signal: strong[0].s, related: [] };
  if (strong.length > 1) return { target: null, signal: null, related: strong.map((x) => x.o.id) };
  if (weak.length === 1) return { target: weak[0], signal: "account", related: [] };
  return { target: null, signal: null, related: weak.map((o) => o.id) };
}
