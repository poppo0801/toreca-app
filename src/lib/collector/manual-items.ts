/**
 * 要手動確認（システム側で解決できなかった候補）の表示用データ（Stage 5T）。
 * 優先収集メモ（利用者が自発的に指定した調査依頼）とは別物で、同じ一覧には混在させない。
 */
import { FAIL_KIND_LABEL, type FailKind } from "@/lib/collector/queue";
import { hostOf, manualRank, urgencyOf, URGENCY_LABEL, type Urgency } from "@/lib/collector/triage";

export interface ManualRow {
  id: string;
  title: string;
  source_url: string | null;
  due_at: string | null;
  manual_reason: string;
  fail_kind: string | null;
  manual_since: string | null;
  draft: unknown;
  /** 最後に取得できた情報（一覧の表示など）。系列・店舗が特定できない案件の手がかりにする */
  last_good?: unknown;
}

export interface ManualItem {
  id: string;
  /** 系列・店舗（解析済みの場合）。不明なら null */
  where: string | null;
  /** 商品（解析済みの場合） */
  products: string[];
  title: string;
  reason: string;
  /** 取得できなかった原因（分類）。取得以外の理由なら null */
  failLabel: string | null;
  dueAt: string | null;
  urgency: Urgency;
  urgencyLabel: string;
  sourceUrl: string | null;
  sourceHost: string | null;
  since: string | null;
  /** 解析済みの内容があり、画面上で編集して登録できる */
  editable: boolean;
  /** now=今すぐ確認（締切が7日以内）/ later=締切に余裕がある・不明（件数の警告には含めない） */
  group: "now" | "later";
  /** 一覧に出す短い理由（詳細は reason / failLabel） */
  shortReason: string;
}

const DAY = 86400_000;
/** 今すぐ確認が必要か: 受付中で、締切が7日以内 */
export const isNowGroup = (dueAt: Date | null, now: Date) => !!dueAt && dueAt.getTime() >= now.getTime() && dueAt.getTime() - now.getTime() <= 7 * DAY;

/** 一覧に出す短い失敗理由。長い文章・URLは詳細に回す */
export function shortReasonOf(x: { where: string | null; products: string[]; failLabel: string | null; hasDraft: boolean; reason?: string }): string {
  if (x.reason?.includes("商品確認待ち")) return "商品確認待ち（マスター未登録）";
  if (!x.where) return x.failLabel ? "店舗不明・公式ページ取得不可" : "店舗不明";
  if (x.products.length === 0 && x.hasDraft) return "商品不明";
  if (x.failLabel) return "公式ページ取得不可";
  return "情報が不足";
}

type DraftLike = { input?: { chain?: { name?: string }; store?: { name?: string }; items?: { product?: { name?: string } }[] } } | null;

/** 一覧の表示（例: 「応募する （店舗名・新しいタブで開きます）」）から、店舗の手がかりになる短い文を作る */
export function lastGoodHint(v: unknown): string | null {
  const g = v as { title?: string; context?: string } | null;
  const t = `${g?.title ?? ""} ${g?.context ?? ""}`.replace(/新しいタブで開きます/g, "").replace(/\s+/g, " ").trim();
  return t.length >= 6 ? t.slice(0, 60) : null;
}

export function toManualItem(r: ManualRow, now: Date): ManualItem {
  const d = (r.draft ?? null) as DraftLike;
  const chain = d?.input?.chain?.name?.trim();
  const store = d?.input?.store?.name?.trim();
  const dueAt = r.due_at ? new Date(r.due_at) : null;
  const urgency = urgencyOf(dueAt, now);
  const kind = r.fail_kind as FailKind | null;
  const where = [chain, store].filter(Boolean).join(" / ") || null;
  const products = (d?.input?.items ?? []).map((i) => i.product?.name?.trim() ?? "").filter(Boolean).slice(0, 4);
  const failLabel = kind && FAIL_KIND_LABEL[kind] ? FAIL_KIND_LABEL[kind] : null;
  return {
    id: r.id,
    where: where || lastGoodHint(r.last_good) || null,
    products,
    title: r.title,
    reason: r.manual_reason || "自動で解決できませんでした",
    failLabel,
    dueAt: r.due_at,
    urgency,
    urgencyLabel: URGENCY_LABEL[urgency],
    sourceUrl: r.source_url,
    sourceHost: hostOf(r.source_url),
    since: r.manual_since,
    editable: !!d?.input,
    group: isNowGroup(dueAt, now) ? "now" : "later",
    shortReason: shortReasonOf({ where, products, failLabel, hasDraft: !!d?.input, reason: r.manual_reason }),
  };
}

/** 締切が近い順（本日→明日→近い→締切不明→余裕あり）。同じ緊急度では締切の早い順、次に重要度の目安として手動確認になった順 */
export function sortManual(items: ManualItem[]): ManualItem[] {
  return items.slice().sort((a, b) => manualRank(a.urgency) - manualRank(b.urgency) || (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9") || (a.since ?? "").localeCompare(b.since ?? ""));
}

/** 最上部の赤い警告の文言 */
export const manualHeadline = (n: number) => `要手動確認：${n}件`;

/** 表示済みの判定用。開いている案件の集合が変わったときだけ、起動時に再度知らせる（閉じただけで対応済みにはしない） */
export function manualSignature(items: Pick<ManualItem, "id">[]): string {
  return items.map((i) => i.id).sort().join(",");
}
