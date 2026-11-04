import { productKey } from "@/lib/lottery-match";
import { normName } from "@/lib/norm";
import type { Chain, Product } from "@/types/domain";

/** 優先収集メモ（世帯共通の収集依頼）。系列＋商品だけでも保存でき、次回以降の収集で優先して調査する */
export const MEMO_STATES = ["unsurveyed", "surveying", "found", "insufficient", "registered", "expired", "withdrawn"] as const;
export type MemoState = (typeof MEMO_STATES)[number];
export const MEMO_STATE_LABEL: Record<MemoState, string> = {
  unsurveyed: "未調査", surveying: "調査中", found: "候補発見", insufficient: "情報不足", registered: "登録済み", expired: "期限切れ・終了", withdrawn: "取り下げ",
};
/** 調査を続ける状態（登録済み・終了・取り下げは履歴として残す） */
export const MEMO_OPEN_STATES: readonly MemoState[] = ["unsurveyed", "surveying", "found", "insufficient"];
export const isMemoOpen = (s: MemoState) => MEMO_OPEN_STATES.includes(s);

export interface MemoInput {
  chainId: string | null;
  chainName: string;
  storeId: string | null;
  storeName: string;
  productIds: string[];
  productNames: string[];
  referenceUrl: string;
  note: string;
  announcedStart: string; // YYYY-MM-DD or ""
  priority: "normal" | "high";
}

export interface MemoRow {
  id: string;
  chainId: string | null;
  chainName: string;
  storeId: string | null;
  storeName: string;
  productIds: string[];
  productNames: string[];
  referenceUrl: string | null;
  note: string;
  announcedStart: string | null;
  priority: "normal" | "high";
  state: MemoState;
  stateDetail: string;
  fetchState: "ok" | "temporary" | "blocked";
  checkCount: number;
  lastCheckedAt: string | null;
  lastContentHash: string | null;
  foundCandidateId: string | null;
  lotteryId: string | null;
  createdAt: string;
}

/** 入力の検証。系列か商品のどちらか（名称だけでも可）が必要。参考URLは http(s) のみ */
export function validateMemoInput(i: MemoInput): { ok: true; value: MemoInput } | { ok: false; error: string } {
  const productNames = i.productNames.map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const chainName = i.chainName.trim().slice(0, 80);
  if (!i.chainId && !chainName && i.productIds.length === 0 && productNames.length === 0) return { ok: false, error: "系列か商品のどちらかを選んでください" };
  const url = i.referenceUrl.trim();
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return { ok: false, error: "参考URLは http(s) から始まるURLを入力してください" };
  if (url.length > 500) return { ok: false, error: "参考URLが長すぎます" };
  if (i.announcedStart && !/^\d{4}-\d{2}-\d{2}$/.test(i.announcedStart)) return { ok: false, error: "開始日の形式が正しくありません" };
  if (i.note.length > 1000) return { ok: false, error: "メモは1000文字までです" };
  return { ok: true, value: { ...i, chainName, productNames, productIds: i.productIds.slice(0, 10), storeName: i.storeName.trim().slice(0, 80), referenceUrl: url, note: i.note.trim(), priority: i.priority === "high" ? "high" : "normal" } };
}

export interface MemoTargets {
  chainKeys: string[];
  productKeys: string[];
  storeKey: string;
}
const MIN_KEY = 3;
/** メモの系列・商品・店舗から、照合用の正規化キーを作る（マスターの別名も使う。未登録の名称は入力のまま） */
export function memoTargets(m: Pick<MemoRow, "chainId" | "chainName" | "productIds" | "productNames" | "storeName">, chains: Chain[], products: Product[]): MemoTargets {
  const chain = m.chainId ? chains.find((c) => c.id === m.chainId) : undefined;
  const chainNames = [chain?.name, ...(chain?.aliases ?? []), m.chainName].filter((s): s is string => !!s);
  const prods = m.productIds.map((id) => products.find((p) => p.id === id)).filter((p): p is Product => !!p);
  const productNames = [...prods.flatMap((p) => [p.officialName, ...p.aliases]), ...m.productNames];
  const uniq = (xs: string[]) => [...new Set(xs.filter((k) => k.length >= MIN_KEY))];
  return { chainKeys: uniq(chainNames.map(normName)), productKeys: uniq(productNames.map(productKey)), storeKey: normName(m.storeName) };
}

/**
 * 文章（候補のタイトル・一覧の表示・解析結果の名称）がメモに該当するか。
 * 商品が指定されていれば商品名の一致が必要（系列だけの一致では該当にしない）。商品が無ければ系列の一致が必要。
 * 店舗は優先度の材料のみ（文章に店舗名が無くても、別の店舗名があっても、該当の可否には使わない）。
 */
export function memoMatchesText(t: MemoTargets, text: string): { match: boolean; chain: boolean; product: boolean; store: boolean } {
  const plain = normName(text);
  const pkey = productKey(text);
  const chain = t.chainKeys.some((k) => plain.includes(k));
  const product = t.productKeys.some((k) => pkey.includes(k));
  const store = t.storeKey.length >= 2 && plain.includes(t.storeKey);
  const needProduct = t.productKeys.length > 0;
  const match = needProduct ? product : chain;
  return { match, chain, product, store };
}

/** 再調査の間隔（時間）。高優先は短く、一時的な失敗は間隔を空ける。恒常的に取得できないものは自動では再取得しない */
export function recheckIntervalHours(m: Pick<MemoRow, "priority" | "fetchState" | "checkCount">): number | null {
  if (m.fetchState === "blocked") return null;
  const base = m.priority === "high" ? 6 : 12;
  return m.fetchState === "temporary" ? Math.min(24, base * 2 * Math.max(1, Math.min(m.checkCount, 3))) : base;
}
export function memoDue(m: MemoRow, now: Date, force = false): boolean {
  if (!isMemoOpen(m.state)) return false;
  if (force) return true;
  const h = recheckIntervalHours(m);
  if (h === null) return false;
  return !m.lastCheckedAt || now.getTime() - new Date(m.lastCheckedAt).getTime() >= h * 3600_000;
}

/** 開始予定日から長く経っても何も見つからないメモは、期限切れとして閉じる（履歴は残す） */
export const MEMO_STALE_DAYS = 45;
export function memoStale(m: MemoRow, now: Date): boolean {
  const base = m.announcedStart ? new Date(`${m.announcedStart}T00:00:00+09:00`) : new Date(m.createdAt);
  return now.getTime() - base.getTime() > MEMO_STALE_DAYS * 86_400_000 && m.state !== "found";
}
