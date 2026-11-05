/**
 * 解析待ち（draft.queued）の組み立て（Stage 6A・純関数）。
 * 再解析のたびに queued を作り直すと、一覧のカード本文・店舗/商品・締切や地域のヒント・周辺の文脈が失われる。
 * robots 制限のページは元ページを取得できず、一覧の情報が唯一の手掛かりなので、取得済みの有効な情報は引き継ぐ。
 *  - 解析が終わった候補の草稿は queued を持たないため、解析時に listInfo として保存し、そこからも復元する
 *  - 新しい一覧の情報（seenAt が新しい）があれば、それを優先する。新しい情報が無い項目だけ、以前の情報を残す
 *  - 一覧以外の出所（再解析の操作・ページ本文の更新）は、一覧の情報を上書きしない
 */
import type { ListHints } from "@/lib/collector/listing";

/** AI解析の実行理由（内部ログ。ユーザー向けの設定は無い） */
export const AI_REASONS = ["initial", "list_change", "page_update", "image_refetch", "manual_reanalyze", "auto_recheck", "reevaluate", "card_enrich", "new_round", "memo_reference", "source_change"] as const;
export type AiReason = (typeof AI_REASONS)[number];
export const AI_REASON_LABEL: Record<AiReason, string> = {
  initial: "初回解析",
  list_change: "一覧の締切変更",
  page_update: "本文更新",
  image_refetch: "画像再取得",
  manual_reanalyze: "手動再解析",
  auto_recheck: "自動再調査",
  reevaluate: "確認待ちの再評価",
  card_enrich: "一覧カードの補完",
  new_round: "新しい抽選回",
  memo_reference: "優先収集メモ",
  source_change: "情報源変更",
};

/** 一覧から取得できた情報（解析が終わっても草稿に残す） */
export interface ListInfo {
  title: string;
  context: string;
  card?: string;
  fields?: { store?: string; product?: string };
  hints?: ListHints;
  sourceName?: string;
  /** この情報を一覧から取得した時刻（ISO）。新旧の判断に使う */
  seenAt: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** 草稿（queued または listInfo）から、以前に取得した一覧の情報を取り出す */
export function listInfoOf(draft: unknown): ListInfo | null {
  if (!isObj(draft)) return null;
  const q = isObj(draft.queued) ? draft.queued : null;
  const li = isObj(draft.listInfo) ? draft.listInfo : null;
  const pick = (k: string) => (q && q[k] !== undefined && q[k] !== "" ? q[k] : li?.[k]);
  const title = String(pick("title") ?? "");
  const context = String(pick("context") ?? "");
  const card = pick("card");
  const fields = pick("fields");
  const hints = pick("hints");
  if (!title && !context && !card && !fields && !hints) return null;
  const seenAt = String((li?.seenAt as string | undefined) ?? (q?.listSeenAt as string | undefined) ?? "");
  return {
    title,
    context,
    ...(typeof card === "string" && card ? { card } : {}),
    ...(isObj(fields) ? { fields: fields as ListInfo["fields"] } : {}),
    ...(isObj(hints) ? { hints: hints as unknown as ListHints } : {}),
    ...(typeof pick("sourceName") === "string" ? { sourceName: String(pick("sourceName")) } : {}),
    seenAt,
  };
}

/** queued から保存用の listInfo を作る（解析後の草稿に残す。長さは抑える） */
export function listInfoFromQueued(q: { title?: string; context?: string; card?: string; fields?: ListInfo["fields"]; hints?: ListHints; sourceName?: string; listSeenAt?: string }, nowIso: string): ListInfo | null {
  if (!q.title && !q.context && !q.card && !q.fields && !q.hints) return null;
  return {
    title: (q.title ?? "").slice(0, 200),
    context: (q.context ?? "").slice(0, 600),
    ...(q.card ? { card: q.card.slice(0, 600) } : {}),
    ...(q.fields ? { fields: q.fields } : {}),
    ...(q.hints ? { hints: q.hints } : {}),
    ...(q.sourceName ? { sourceName: q.sourceName } : {}),
    seenAt: q.listSeenAt ?? nowIso,
  };
}

/** X投稿の取得済み情報を再利用する期間（日）。これを過ぎたら再取得する（保存・再利用の範囲を限定し、画像URLの期限切れも避ける） */
export const XPOST_REUSE_DAYS = 30;

/** 草稿に保存したX投稿の情報から、再解析用の post を復元する（期限内のものだけ） */
export function storedPostOf(draft: unknown, now: Date = new Date()): Obj | null {
  if (!isObj(draft)) return null;
  const q = isObj(draft.queued) && isObj(draft.queued.post) ? draft.queued.post : null;
  if (q) return q;
  const s = isObj(draft.xpost) ? draft.xpost : null;
  if (!s || typeof s.id !== "string") return null;
  const age = (now.getTime() - new Date(String(s.fetchedAt ?? "")).getTime()) / 86_400_000;
  if (!Number.isFinite(age) || age > XPOST_REUSE_DAYS) return null;
  return { id: s.id, text: s.text ?? "", images: s.images ?? [], links: s.links ?? [], createdAt: s.createdAt ?? "", username: s.username ?? "", ...(isObj(s.profile) ? { profile: s.profile } : {}), ...(isObj(s.quoted) ? { quoted: s.quoted } : {}) };
}

export interface RebuildBase {
  kind: "web_page" | "x_oembed" | "x_post";
  url: string;
  sourceName: string;
  reason: AiReason;
  /** 一覧の情報が何も残っていないときの題名（候補の題名） */
  fallbackTitle?: string;
  /** 内容の変更を検出した再解析 */
  changed?: boolean;
  /** 既定で優先収集メモ等の付加情報を引き継ぐ */
  extra?: Obj;
}

/**
 * 再解析のための queued を作る。prior=現在の草稿、fresh=今回、一覧から新しく取得した情報（あれば）。
 * 新しい情報（seenAt が以前以上）があれば項目ごとに優先し、無い項目は以前の情報を残す。
 */
export function rebuildQueued(prior: unknown, base: RebuildBase, fresh?: Partial<ListInfo> & { seenAt: string }): Obj {
  const old = listInfoOf(prior);
  const priorQ: Obj = { ...(isObj(prior) && isObj(prior.queued) ? prior.queued : {}) };
  // 前回の解析で付いた結果の印は引き継がない（今回の解析で改めて判断する）
  for (const k of ["viaList", "viaKind", "newRound"]) delete priorQ[k];
  const freshWins = !!fresh && (!old?.seenAt || fresh.seenAt >= old.seenAt);
  const pickVal = <K extends keyof ListInfo>(k: K): ListInfo[K] | undefined => {
    const f = fresh?.[k] as ListInfo[K] | undefined;
    const o = old?.[k];
    const has = (v: unknown) => v !== undefined && v !== "" && v !== null;
    if (freshWins && has(f)) return f;
    if (has(o)) return o;
    return has(f) ? f : undefined;
  };
  const title = pickVal("title") ?? base.fallbackTitle ?? "";
  const context = pickVal("context") ?? "";
  const card = pickVal("card");
  const fields = pickVal("fields");
  const hints = pickVal("hints");
  const seenAt = freshWins && fresh ? fresh.seenAt : (old?.seenAt ?? "");
  // X投稿は、保存済みの本文・画像URL・引用元・リンクがあれば再取得せずに使う（同じ投稿を必要なく再取得・再解析しない）
  const post = base.kind === "web_page" ? null : storedPostOf(prior);
  return {
    // 優先収集メモの関連・X投稿の本文など、元の queued にある付加情報は残す
    ...priorQ,
    ...(base.extra ?? {}),
    kind: post ? "x_post" : base.kind,
    ...(post ? { post } : {}),
    url: base.url,
    title,
    context,
    ...(card ? { card } : {}),
    ...(fields ? { fields } : {}),
    ...(hints ? { hints } : {}),
    ...(seenAt ? { listSeenAt: seenAt } : {}),
    sourceName: old?.sourceName && base.sourceName === "再解析" ? old.sourceName : base.sourceName,
    attempts: 0,
    reason: base.reason,
    ...(base.changed ? { changed: true } : { changed: false }),
  };
}
