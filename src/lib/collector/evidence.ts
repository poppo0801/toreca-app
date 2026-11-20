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
  } else if (src.viaList && src.card) {
    parts.push(src.card);
    via = "list_card";
    origin = "secondary";
  } else {
    const t = src.card || src.context || "";
    if (!t) return null;
    parts.push(t);
    via = "web_fetch";
  }
  const joined = clean(parts.join("\n"));
  if (joined.length < 8) return null;
  const text = joined.slice(0, MAX_EVIDENCE_CHARS);
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
  };
}

/** 保存済みの行（last_good の jsonb）から、この形式の記録だけを取り出す。形式が合わない・古い記録は無視する（保存済みとして扱わない） */
export function evidenceFromLastGood(lastGood: unknown): StoredEvidence | null {
  if (!lastGood || typeof lastGood !== "object") return null;
  const e = (lastGood as { evidence?: unknown }).evidence as Partial<StoredEvidence> | undefined;
  if (!e || e.v !== EVIDENCE_VERSION || typeof e.url !== "string" || typeof e.text !== "string" || e.text.length < 8 || typeof e.fetchedAt !== "string" || typeof e.hash !== "string") return null;
  return { ...(e as StoredEvidence), links: Array.isArray(e.links) ? e.links.slice(0, 5) : [] };
}
