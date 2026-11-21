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

export interface ImageReading {
  /** 項目（applyDeadline など。AIが根拠を示した項目名） */
  field: string;
  /** AIが画像から読み取った短い抜粋（伏せ字済み・最大200字）。原文ではない */
  text: string;
  /** AIが申告した出所（例: 画像1枚目）。不明は空 */
  source: string;
  /** 何枚目の画像か（1始まり）。不明は null */
  imageIndex: number | null;
  /** 読み取りの種類: ai_reading=画像を解析したAIの読み取り（OCRの区別: 現在の解析は構造化抽出であり、文字起こしではない） */
  kind: "ai_reading";
  /** 原本の画像と照合した結果。画像は保存しないため常に null（照合できない） */
  verified: null;
  /** 読み取りの確度（AIの申告）。不明は null */
  uncertainty: "high" | "medium" | "low" | null;
  /** 読み取りの日時（収集時の解析の日時） */
  readAt: string;
}

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
  /**
   * Stage 10K（追加の項目）: 収集時に既に行った画像解析（AI）が読み取った、画像由来の根拠（項目ごとの短い抜粋）。**原文（text・linkedPages）とは別の出典**で、
   * 画像そのものは保存しない・再解析しない。AIの読み取り（OCRではない）で、原本と照合できない（verified は常に null）。無い記録は「画像読み取りなし」。
   */
  imageReadings?: ImageReading[];
  /** 元画像への参照（公開の画像URL。最大4件・https）。画像そのものは保存しない */
  imageRefs?: string[];
  /** Stage 10M（追加の項目）: 本文中の短縮URL（t.co）→展開後のURL の対応（最大30件）。まとめ投稿の項目ごとの応募先の特定に使う */
  linkMap?: { short: string; url: string }[];
}

export interface EvidenceSource {
  url: string;
  kind: "web_page" | "x_oembed" | "x_post";
  /** 一覧のカード全体の文章（二次情報） */
  card?: string;
  context?: string;
  post?: { text: string; links?: string[]; linkMap?: { short: string; url: string }[]; images?: string[]; username?: string; quoted?: { text: string; links?: string[]; images?: string[] } };
  /** 収集の解析時に実際に取得できたページ・投稿の本文（直接取得したページの本文など） */
  fetchedText?: string;
  fetchedVia?: EvidenceVia;
  xVia?: "api" | "oembed";
  viaList?: boolean;
  imageStatus?: StoredEvidence["imageStatus"];
  /** 投稿内のリンク先の公開ページ本文（収集時に取得済みのもの） */
  linkedPages?: { url: string; text: string }[];
  /** 収集時の画像解析の読み取り（`imageReadingsFromExtraction` の結果） */
  imageReadings?: ImageReading[];
  /** 元画像への参照（公開URL） */
  imageRefs?: string[];
}

/**
 * 収集時の解析結果（`extraction.evidence`: 項目ごとの原文の抜粋と、AIが申告した出所）から、**出所が画像のものだけ**を画像読み取りとして取り出す（既に得ている結果の再利用。画像は再解析しない）。
 * 出所が本文・リンク先のものは対象外（原文として別に保存されている）。
 */
export function imageReadingsFromExtraction(
  ex: { evidence?: Partial<Record<string, { quote: string; source?: string }>>; confidence?: Partial<Record<string, string>> } | null | undefined,
  nowIso: string,
): ImageReading[] {
  const out: ImageReading[] = [];
  for (const [field, item] of Object.entries(ex?.evidence ?? {})) {
    if (!item || typeof item.quote !== "string" || !/画像|image|添付/i.test(item.source ?? "")) continue;
    const text = clean(item.quote).slice(0, 200);
    if (text.length < 2) continue;
    const m = /([0-9０-９]+)[ \t]*枚目/.exec(item.source ?? "");
    const conf = ex?.confidence?.[field];
    out.push({ field, text, source: String(item.source ?? "").slice(0, 20), imageIndex: m ? Number(m[1].normalize("NFKC")) : null, kind: "ai_reading", verified: null, uncertainty: conf === "high" || conf === "medium" || conf === "low" ? conf : null, readAt: nowIso });
    if (out.length >= 12) break;
  }
  return out;
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
  const imageReadings = (src.imageReadings ?? []).slice(0, 12);
  const linkMap = (src.post?.linkMap ?? []).filter((m) => m && typeof m.short === "string" && typeof m.url === "string" && m.short.startsWith("https://t.co/") && m.url.startsWith("https://")).map((m) => ({ short: m.short.slice(0, 40), url: m.url.slice(0, 300) })).slice(0, 30);
  const imageRefs = (src.imageRefs ?? []).filter((u) => typeof u === "string" && u.startsWith("https://")).map((u) => u.slice(0, 500)).slice(0, 4);
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
    ...(imageReadings.length ? { imageReadings } : {}),
    ...(imageRefs.length ? { imageRefs } : {}),
    ...(linkMap.length ? { linkMap } : {}),
  };
}

/** 保存済みの行（last_good の jsonb）から、この形式の記録だけを取り出す。形式が合わない・古い記録は無視する（保存済みとして扱わない） */
export function evidenceFromLastGood(lastGood: unknown): StoredEvidence | null {
  if (!lastGood || typeof lastGood !== "object") return null;
  const e = (lastGood as { evidence?: unknown }).evidence as Partial<StoredEvidence> | undefined;
  if (!e || e.v !== EVIDENCE_VERSION || typeof e.url !== "string" || typeof e.text !== "string" || e.text.length < 8 || typeof e.fetchedAt !== "string" || typeof e.hash !== "string") return null;
  const linkedPages = Array.isArray(e.linkedPages) ? e.linkedPages.filter((l) => l && typeof l.url === "string" && typeof l.text === "string").slice(0, 2) : undefined;
  const { linkedPages: _ignored, imageReadings: _ir, imageRefs: _refs, linkMap: _lm, ...rest } = e as StoredEvidence;
  void _lm;
  void _ignored;
  void _ir;
  void _refs;
  const imageReadings = Array.isArray(e.imageReadings) ? e.imageReadings.filter((r) => r && r.kind === "ai_reading" && typeof r.text === "string" && typeof r.field === "string").slice(0, 12) : undefined;
  const linkMap = Array.isArray(e.linkMap) ? e.linkMap.filter((m) => m && typeof m.short === "string" && typeof m.url === "string").slice(0, 30) : undefined;
  const imageRefs = Array.isArray(e.imageRefs) ? e.imageRefs.filter((u) => typeof u === "string" && u.startsWith("https://")).slice(0, 4) : undefined;
  return { ...rest, links: Array.isArray(e.links) ? e.links.slice(0, 5) : [], ...(linkedPages?.length ? { linkedPages } : {}), ...(imageReadings?.length ? { imageReadings } : {}), ...(imageRefs?.length ? { imageRefs } : {}), ...(linkMap?.length ? { linkMap } : {}) };
}
