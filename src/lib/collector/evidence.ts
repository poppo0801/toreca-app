import { createHash } from "node:crypto";
import { redact } from "@/lib/case-model/redact";

/**
 * Stage 9Z: 初回収集で実際に取得した原文（投稿本文・一覧のカード・ページの要点）の保存形式。
 *  - AIが抽出した値（draft.input）とは別物として保存する。ここにあるのは「取得した原文」だけで、AIの推測・要約は含めない。
 *  - 元のURL・取得日時・取得方法・出どころ・本文のハッシュを残し、後の再検証で「保存済みの一次情報」として再利用できる。
 *  - 個人情報・APIキーは伏せ字にし、本文は最大 MAX_EVIDENCE_CHARS 文字に切り詰める（保存容量・外部コンテンツの取り扱い）。画像そのものは保存しない（枚数と取得状態のみ）。
 *  - 保存されていない過去の情報を、取得済みとして扱わない（この形式の記録が無ければ「保存なし」）。
 */
export const MAX_EVIDENCE_CHARS = 3500;
export const EVIDENCE_VERSION = 1;
/** リンク先の公開ページ本文の保存上限（1ページあたり）。保存容量を抑える */
export const MAX_LINKED_PAGE_CHARS = 3000;

/** 取得方法: x_api=X公式API／x_oembed=公開oEmbed（本文のみ）／web_fetch=ページを直接取得／list_card=まとめサイト一覧のカード（二次情報） */
export type EvidenceVia = "x_api" | "x_oembed" | "web_fetch" | "list_card";

export interface StoredEvidence {
  v: number;
  /** 元の投稿・ページのURL */
  url: string;
  /** 取得日時（ISO） */
  fetchedAt: string;
  via: EvidenceVia;
  /** 出どころ: 一次＝告知した店舗・主催者本人の投稿／ページ、二次＝転載・まとめ。判別できないときは unknown（一次とみなさない） */
  origin: "primary" | "secondary" | "unknown";
  /** 取得した原文（伏せ字済み・切り詰め済み）。AIの要約・抽出結果ではない */
  text: string;
  truncated: boolean;
  /** 原文に含まれていたリンク先（最大5件） */
  links: string[];
  /** 添付画像の数と取得状態（画像そのものは保存しない） */
  imageCount: number;
  imageStatus: "none" | "not_fetched" | "partial" | "fetched";
  /** 同じ原文の判定用ハッシュ */
  hash: string;
  /**
   * Stage 10J（追加の項目。無い記録は従来どおり）: text の出どころ。post=投稿本文／fetched_page=直接取得したページ本文／list_card=まとめサイトの一覧カード／card_or_context=カード・文脈の文章（ページ本文ではない）。
   * 取得方法（via）だけでは「本文が短い理由」を判別できないため、区別して残す。
   */
  textSource?: "post" | "fetched_page" | "list_card" | "card_or_context";
  /**
   * Stage 10J（追加の項目）: 投稿内のリンク先の公開ページ本文（収集時に既に取得していたもの。最大2件・各3,000字・伏せ字済み）。
   * 投稿本文（text）とは**別の出典**として分けて保存する（混同しない）。本文が無い・取得できなかった場合は付けない。
   */
  linkedPages?: { url: string; text: string; fetchedAt: string }[];
}

export interface EvidenceSource {
  url: string;
  kind: "web_page" | "x_oembed" | "x_post";
  /** 一覧のカード全体の文章（二次情報） */
  card?: string;
  context?: string;
  post?: { text: string; links?: string[]; images?: string[]; username?: string; quoted?: { text: string; links?: string[]; images?: string[] } };
  /** 収集の解析時に実際に取得できたページ・投稿の本文（直接取得したページの本文など） */
  fetchedText?: string;
  fetchedVia?: EvidenceVia;
  xVia?: "api" | "oembed";
  viaList?: boolean;
  imageStatus?: StoredEvidence["imageStatus"];
  /** 投稿内のリンク先の公開ページ本文（収集時に取得済みのもの） */
  linkedPages?: { url: string; text: string }[];
}

const clean = (s: string) => redact(s.replace(/\s+/g, " ").trim());

/** URLの照合用の正規化（フラグメント・末尾スラッシュ・トラッキング用の引数を除く） */
export function normalizeEvidenceUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|s$|t$|ref_src|ref_url)/i.test(k)) u.searchParams.delete(k);
    return `${u.protocol}//${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim();
  }
}

/** 収集時に取得した内容から、保存する原文の記録を作る。保存できる原文が無ければ null（AIの抽出結果だけでは作らない） */
export function buildEvidence(src: EvidenceSource, nowIso: string): StoredEvidence | null {
  const parts: string[] = [];
  let via: EvidenceVia;
  let origin: StoredEvidence["origin"] = "unknown";
  const links: string[] = [];
  let imageCount = 0;
  let textSource: NonNullable<StoredEvidence["textSource"]> = "post";
  if (src.kind === "x_post" || src.kind === "x_oembed") {
    const p = src.post;
    if (!p?.text) return null;
    parts.push(p.text);
    if (p.quoted?.text) parts.push(`（引用元）${p.quoted.text}`);
    links.push(...(p.links ?? []), ...(p.quoted?.links ?? []));
    imageCount = (p.images?.length ?? 0) + (p.quoted?.images?.length ?? 0);
    via = src.kind === "x_oembed" || src.xVia === "oembed" ? "x_oembed" : "x_api";
  } else if (src.fetchedText && src.fetchedText.trim().length >= 8) {
    parts.push(src.fetchedText);
    via = src.fetchedVia ?? "web_fetch";
    textSource = "fetched_page";
  } else if (src.viaList && src.card) {
    parts.push(src.card);
    via = "list_card";
    origin = "secondary";
    textSource = "list_card";
  } else {
    const t = src.card || src.context || "";
    if (!t) return null;
    parts.push(t);
    via = "web_fetch";
    textSource = "card_or_context";
  }
  const joined = clean(parts.join("\n"));
  if (joined.length < 8) return null;
  const text = joined.slice(0, MAX_EVIDENCE_CHARS);
  const linkedPages = (src.linkedPages ?? [])
    .map((l) => ({ url: String(l.url).slice(0, 500), text: clean(String(l.text)).slice(0, MAX_LINKED_PAGE_CHARS), fetchedAt: nowIso }))
    .filter((l) => l.url.startsWith("https://") && l.text.length >= 30)
    .slice(0, 2);
  return {
    v: EVIDENCE_VERSION,
    url: src.url.slice(0, 500),
    fetchedAt: nowIso,
    via,
    origin,
    text,
    truncated: joined.length > text.length,
    links: [...new Set(links)].filter((l) => /^https?:\/\//.test(l)).slice(0, 5),
    imageCount,
    imageStatus: src.imageStatus ?? (imageCount === 0 ? "none" : "not_fetched"),
    hash: createHash("sha256").update(text).digest("hex").slice(0, 32),
    textSource,
    ...(linkedPages.length ? { linkedPages } : {}),
  };
}

/** 保存済みの行（last_good の jsonb）から、この形式の記録だけを取り出す。形式が合わない・古い記録は無視する（保存済みとして扱わない） */
export function evidenceFromLastGood(lastGood: unknown): StoredEvidence | null {
  if (!lastGood || typeof lastGood !== "object") return null;
  const e = (lastGood as { evidence?: unknown }).evidence as Partial<StoredEvidence> | undefined;
  if (!e || e.v !== EVIDENCE_VERSION || typeof e.url !== "string" || typeof e.text !== "string" || e.text.length < 8 || typeof e.fetchedAt !== "string" || typeof e.hash !== "string") return null;
  const linkedPages = Array.isArray(e.linkedPages) ? e.linkedPages.filter((l) => l && typeof l.url === "string" && typeof l.text === "string").slice(0, 2) : undefined;
  const { linkedPages: _ignored, ...rest } = e as StoredEvidence;
  void _ignored;
  return { ...rest, links: Array.isArray(e.links) ? e.links.slice(0, 5) : [], ...(linkedPages?.length ? { linkedPages } : {}) };
}
