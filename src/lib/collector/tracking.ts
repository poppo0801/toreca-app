/**
 * 抽選予告の追跡（Stage 6C・純関数）。
 * 受付前・詳細未発表の抽選は、候補として保持し続け、続報（新しい投稿・更新）が見つかったら同じ抽選として更新する。
 *  - 続報の照合: 系列・商品が一致し、店舗は双方が分かっていれば一致すること。一意に決まらない場合は統合せず、関連候補として保持する
 *  - 更新の履歴: 受付開始日・応募締切・応募URL・応募条件・対象商品・店舗が分かった/変わったことを、情報源と日時つきで残す
 *  - 不明な項目は推測で補わない
 */
import { chainKey, productKey } from "@/lib/lottery-match";
import { normName } from "@/lib/norm";
import type { LotteryInput } from "@/lib/lottery-input";

export interface TrackingEntry {
  at: string;
  source: string;
  kind: "start_known" | "deadline_known" | "apply_url_known" | "conditions_known" | "product_changed" | "store_added" | "start_changed" | "deadline_changed";
  label: string;
}

export interface Tracking {
  /** 追跡を始めた日時（最初の発見） */
  since: string;
  /** 最後に情報が更新された日時 */
  lastNewsAt: string;
  /** 受付開始予定（判明していれば） */
  startDate: string | null;
  sources: { url: string; at: string }[];
  history: TrackingEntry[];
  /** 同一と確定できなかった関連候補 */
  related?: string[];
  /** 正式な抽選として登録した日時と抽選ID */
  promotedAt?: string;
  promotedLotteryId?: string;
}

const known = (f?: { precision: string; date?: string | null }) => !!f && f.precision !== "unknown" && !!f.date;
const dateOf = (f?: { date?: string | null }) => f?.date ?? "";
const applyUrlOf = (i: LotteryInput) => /応募URL:\s*(\S+)/.exec(i.memo ?? "")?.[1] ?? "";
const prodNames = (i: LotteryInput) => i.items.map((x) => normName(x.product.name)).filter(Boolean).sort();

/** 前回の入力と今回の入力の差から、追跡の更新履歴を作る（前回に無く今回ある・変わった項目だけ） */
export function diffTracking(prev: LotteryInput | null, next: LotteryInput, at: string, source: string): TrackingEntry[] {
  const out: TrackingEntry[] = [];
  const add = (kind: TrackingEntry["kind"], label: string) => out.push({ at, source, kind, label });
  if (!prev) return out;
  if (!known(prev.applyStart) && known(next.applyStart)) add("start_known", `受付開始日が判明: ${dateOf(next.applyStart)}`);
  else if (known(prev.applyStart) && known(next.applyStart) && dateOf(prev.applyStart) !== dateOf(next.applyStart)) add("start_changed", `受付開始日が変更: ${dateOf(prev.applyStart)} → ${dateOf(next.applyStart)}`);
  if (!known(prev.applyDeadline) && known(next.applyDeadline)) add("deadline_known", `応募締切が判明: ${dateOf(next.applyDeadline)}`);
  else if (known(prev.applyDeadline) && known(next.applyDeadline) && dateOf(prev.applyDeadline) !== dateOf(next.applyDeadline)) add("deadline_changed", `応募締切が変更: ${dateOf(prev.applyDeadline)} → ${dateOf(next.applyDeadline)}`);
  if (!applyUrlOf(prev) && applyUrlOf(next)) add("apply_url_known", "応募URLが判明");
  const hadCond = !!(prev.conditionsText?.trim() || (prev.requirementTags ?? []).length > 0);
  const hasCond = !!(next.conditionsText?.trim() || (next.requirementTags ?? []).length > 0);
  if (!hadCond && hasCond) add("conditions_known", "応募条件が判明");
  if (!prev.store.name.trim() && next.store.name.trim()) add("store_added", `店舗が判明: ${next.store.name.trim()}`);
  const a = prodNames(prev);
  const b = prodNames(next);
  if (a.length > 0 && b.length > 0 && a.join("|") !== b.join("|")) add("product_changed", "対象商品が変更されました");
  return out;
}

export interface TrackedLite {
  id: string;
  input: LotteryInput;
  tracking: Tracking;
  created_at: string;
}

export interface MatchResult {
  /** 一意に決まったとき */
  match: TrackedLite | null;
  /** 複数に一致して決められないとき（統合せず、関連候補として保持する） */
  ambiguous: string[];
}

/**
 * 追跡中の予告のうち、今回の候補と同じ抽選の続報とみなせるものを探す。
 * 条件: 系列が同じ（ID または名称）・対象商品が共通（ID または照合キー）・店舗は双方が分かっていれば同じ。商品と締切日だけの一致では統合しない。
 */
export function matchTracked(tracked: TrackedLite[], next: LotteryInput, selfId: string): MatchResult {
  const hits: TrackedLite[] = [];
  const nProdIds = new Set(next.items.map((i) => i.product.id).filter((x): x is string => !!x));
  const nProdKeys = new Set(next.items.map((i) => productKey(i.product.name)).filter((k) => k.length >= 3));
  for (const t of tracked) {
    if (t.id === selfId) continue;
    const p = t.input;
    const sameChain = (!!p.chain.id && p.chain.id === next.chain.id) || (!!p.chain.name.trim() && !!next.chain.name.trim() && chainKey(p.chain.name) === chainKey(next.chain.name));
    if (!sameChain) continue;
    const sameProduct = p.items.some((i) => (!!i.product.id && nProdIds.has(i.product.id)) || nProdKeys.has(productKey(i.product.name)));
    if (!sameProduct) continue;
    const ps = p.store.name.trim();
    const ns = next.store.name.trim();
    const storeCompatible = !ps || !ns || (!!p.store.id && p.store.id === next.store.id) || normName(ps) === normName(ns);
    if (!storeCompatible) continue;
    hits.push(t);
  }
  if (hits.length === 1) return { match: hits[0], ambiguous: [] };
  return { match: null, ambiguous: hits.map((h) => h.id) };
}

/** 追跡を引き継ぐ（続報の候補が、以前の予告の追跡情報・履歴を受け継ぐ） */
export function inheritTracking(prev: Tracking | null, now: string, url: string, startDate: string | null, entries: TrackingEntry[]): Tracking {
  const sources = [...(prev?.sources ?? [])];
  if (!sources.some((s) => s.url === url)) sources.push({ url, at: now });
  return {
    since: prev?.since ?? now,
    lastNewsAt: entries.length > 0 || !prev ? now : prev.lastNewsAt,
    startDate: startDate ?? prev?.startDate ?? null,
    sources: sources.slice(-10),
    history: [...(prev?.history ?? []), ...entries].slice(-30),
    ...(prev?.related ? { related: prev.related } : {}),
  };
}
