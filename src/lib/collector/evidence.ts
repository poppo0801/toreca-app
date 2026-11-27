import { createHash } from "node:crypto";
import { redact } from "@/lib/case-model/redact";
import { normalizeForHash } from "./queue";

/**
 * Stage 9Z: 初回収集で実際に取得した原文（投稿本文・一覧のカード・ページの要点）の保存形式。
 *  - AIが抽出した値（draft.input）とは別物として保存する。ここにあるのは「取得した原文」だけで、AIの推測・要約は含めない。
 *  - 元のURL・取得日時・取得方法・出どころ・本文のハッシュを残し、後の再検証で「保存済みの一次情報」として再利用できる。
 *  - 個人情報・APIキーは伏せ字にし、本文は最大 MAX_EVIDENCE_CHARS 文字に切り詰める（保存容量・外部コンテンツの取り扱い）。画像そのものは保存しない（枚数と取得状態のみ）。
 *  - 保存されていない過去の情報を、取得済みとして扱わない（この形式の記録が無ければ「保存なし」）。
 */
/** 投稿・ページ本文の抜粋上限。以前は3,500字（長い投稿の後半が欠けた）。X投稿は最大約25,000字。全文は evidence_documents にも保存する（truncated で切れを明示） */
export const MAX_EVIDENCE_CHARS = 12_000;
export const EVIDENCE_VERSION = 1;
/**
 * リンク先の公開ページ本文を last_good（jsonb）に抜粋として持つ上限（1ページあたり）。**全文はここではなく evidence_documents（migration 115）へ保存する**。
 * 抜粋が全文より短いページは truncated=true と fullChars を残し、「後半は未確認」を判別できるようにする（無いのではなく未確認）。
 */
export const MAX_LINKED_PAGE_CHARS = 6000;
/** 1投稿から保存するリンク先ページ数の上限（以前は2件。複数店舗・商品を含む投稿の2件目以降が欠けていた）。取得側の上限（link-plan）と整合 */
export const MAX_LINKED_PAGES = 30;
/** 原文に含まれていたリンク先のURLの保存上限（以前は5件）。発見した全リンクの台帳は linkLedger */
export const MAX_EVIDENCE_LINKS = 60;
export const MAX_LINK_LEDGER = 80;
/** 元画像への参照の保存上限（以前は4件） */
export const MAX_IMAGE_REFS = 16;

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
  linkedPages?: { url: string; text: string; fetchedAt: string; /** 取得時の全文の字数。text が抜粋のとき fullChars > text.length */ fullChars?: number; /** 全文（抜粋の外を含む）の正規化ハッシュ16桁。抜粋の外の更新も検知する（CAPABILITY_CEILING） */ fullHash?: string; /** 抜粋または取得元が切れている（後半は未確認） */ truncated?: boolean; depth?: 0 | 1; fromUrl?: string; origins?: string[]; shortUrl?: string }[];
  /** Phase 2: 発見した全リンクの台帳（取得できた／できなかった／選ばなかった理由）。無言の欠落を防ぐ（取得できなかったリンクを「無い」と扱わない） */
  linkLedger?: { url: string; key: string; host: string; order: number; origins: string[]; shortUrl?: string; status: string; reason?: string; chars?: number; truncated?: boolean; at?: string }[];
  /**
   * Stage 10K（追加の項目）: 収集時に既に行った画像解析（AI）が読み取った、画像由来の根拠（項目ごとの短い抜粋）。**原文（text・linkedPages）とは別の出典**で、
   * 画像そのものは保存しない・再解析しない。AIの読み取り（OCRではない）で、原本と照合できない（verified は常に null）。無い記録は「画像読み取りなし」。
   */
  imageReadings?: ImageReading[];
  /** 元画像への参照（公開の画像URL。最大4件・https）。画像そのものは保存しない */
  imageRefs?: string[];
  /** Stage 10M（追加の項目）: 本文中の短縮URL（t.co）→展開後のURL の対応（最大30件）。まとめ投稿の項目ごとの応募先の特定に使う */
  linkMap?: { short: string; url: string }[];
  /** Phase 2: 再調査で取得したリンク先を戻した回数（同じ候補への書き戻しの楽観的排他に使う）。無ければ0 */
  recheckSeq?: number;
  /**
   * Phase 2: 上限・切り詰めで実際に失われた情報の件数（0より大きいものだけ）。**無言の欠落を作らないための記録**（上限の十分性を継続的に監査する材料。limits-audit）。
   * textTruncated=本文が上限で切れた／linksDropped=リンクが上限で落ちた／ledgerDropped=台帳が上限で落ちた／pagesDropped*=リンク先ページが（https以外・短すぎ・件数上限で）保存対象から外れた／pagesTruncated=抜粋が全文より短い／imageRefsDropped・imageReadingsDropped・linkMapDropped
   */
  limitHits?: Record<string, number>;
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
  linkedPages?: { url: string; text: string; fullChars?: number; truncated?: boolean; depth?: 0 | 1; fromUrl?: string; origins?: string[]; shortUrl?: string }[];
  linkLedger?: StoredEvidence["linkLedger"];
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
  const hits: Record<string, number> = {};
  const hit = (k: string, n: number) => {
    if (n > 0) hits[k] = n;
  };
  hit("textTruncated", joined.length - text.length);
  hit("imageReadingsDropped", (src.imageReadings ?? []).length - imageReadings.length);
  const linkMap = (src.post?.linkMap ?? []).filter((m) => m && typeof m.short === "string" && typeof m.url === "string" && m.short.startsWith("https://t.co/") && m.url.startsWith("https://")).map((m) => ({ short: m.short.slice(0, 40), url: m.url.slice(0, 300) })).slice(0, 30);
  const imageRefs = (src.imageRefs ?? []).filter((u) => typeof u === "string" && u.startsWith("https://")).map((u) => u.slice(0, 500)).slice(0, MAX_IMAGE_REFS);
  const linkedPagesAll = (src.linkedPages ?? [])
    .map((l) => {
      const full = clean(String(l.text));
      const text = full.slice(0, MAX_LINKED_PAGE_CHARS);
      const fullChars = Math.max(full.length, l.fullChars ?? 0);
      return { url: String(l.url).slice(0, 500), text, fetchedAt: nowIso, fullChars, fullHash: createHash("sha256").update(normalizeForHash(full)).digest("hex").slice(0, 16), truncated: text.length < fullChars || !!l.truncated, ...(l.depth !== undefined ? { depth: l.depth } : {}), ...(l.fromUrl ? { fromUrl: l.fromUrl.slice(0, 500) } : {}), ...(l.origins?.length ? { origins: l.origins.slice(0, 4) } : {}), ...(l.shortUrl ? { shortUrl: l.shortUrl.slice(0, 40) } : {}) };
    })
    ;
  const linkedPagesOk = linkedPagesAll.filter((l) => l.url.startsWith("https://") && l.text.length >= 30);
  const linkedPages = linkedPagesOk.slice(0, MAX_LINKED_PAGES);
  hit("pagesDroppedNotHttps", linkedPagesAll.filter((l) => !l.url.startsWith("https://")).length);
  hit("pagesDroppedTooShort", linkedPagesAll.filter((l) => l.url.startsWith("https://") && l.text.length < 30).length);
  hit("pagesDroppedOverCap", linkedPagesOk.length - linkedPages.length);
  hit("pagesTruncated", linkedPages.filter((l) => l.truncated).length);
  const keptUrls = new Set(linkedPages.map((l) => l.url));
  const ledgerAll = src.linkLedger ?? [];
  hit("ledgerDropped", ledgerAll.length - Math.min(ledgerAll.length, MAX_LINK_LEDGER));
  // 保存対象から外れたページは、台帳で「取得済み」のままにせず、保存されなかった理由を残す（無言の欠落にしない）
  const linkLedger = ledgerAll.slice(0, MAX_LINK_LEDGER).map((e) => {
    const lost = e.status === "fetched" && !keptUrls.has(String(e.url).slice(0, 500)) && linkedPagesAll.length > 0;
    return { ...e, ...(lost ? { status: "skipped" as const, reason: "not_stored" } : {}), url: String(e.url).slice(0, 500), key: String(e.key).slice(0, 300), ...(!lost && e.reason ? { reason: String(e.reason).slice(0, 160) } : {}) };
  });
  const linksAll = [...new Set(links)].filter((l) => /^https?:\/\//.test(l));
  hit("linksDropped", linksAll.length - Math.min(linksAll.length, MAX_EVIDENCE_LINKS));
  hit("imageRefsDropped", (src.imageRefs ?? []).filter((u) => typeof u === "string" && u.startsWith("https://")).length - imageRefs.length);
  hit("linkMapDropped", (src.post?.linkMap ?? []).filter((m) => m && typeof m.short === "string" && typeof m.url === "string" && m.short.startsWith("https://t.co/") && m.url.startsWith("https://")).length - linkMap.length);
  return {
    v: EVIDENCE_VERSION,
    url: src.url.slice(0, 500),
    fetchedAt: nowIso,
    via,
    origin,
    text,
    truncated: joined.length > text.length,
    links: [...new Set(links)].filter((l) => /^https?:\/\//.test(l)).slice(0, MAX_EVIDENCE_LINKS),
    imageCount,
    imageStatus: src.imageStatus ?? (imageCount === 0 ? "none" : "not_fetched"),
    hash: createHash("sha256").update(text).digest("hex").slice(0, 32),
    textSource,
    ...(linkedPages.length ? { linkedPages } : {}),
    ...(linkLedger.length ? { linkLedger } : {}),
    ...(imageReadings.length ? { imageReadings } : {}),
    ...(imageRefs.length ? { imageRefs } : {}),
    ...(linkMap.length ? { linkMap } : {}),
    ...(Object.keys(hits).length ? { limitHits: hits } : {}),
  };
}

/** 保存済みの行（last_good の jsonb）から、この形式の記録だけを取り出す。形式が合わない・古い記録は無視する（保存済みとして扱わない） */
export function evidenceFromLastGood(lastGood: unknown): StoredEvidence | null {
  if (!lastGood || typeof lastGood !== "object") return null;
  const e = (lastGood as { evidence?: unknown }).evidence as Partial<StoredEvidence> | undefined;
  if (!e || e.v !== EVIDENCE_VERSION || typeof e.url !== "string" || typeof e.text !== "string" || e.text.length < 8 || typeof e.fetchedAt !== "string" || typeof e.hash !== "string") return null;
  const linkedPages = Array.isArray(e.linkedPages) ? e.linkedPages.filter((l) => l && typeof l.url === "string" && typeof l.text === "string").slice(0, MAX_LINKED_PAGES) : undefined;
  const linkLedger = Array.isArray(e.linkLedger) ? e.linkLedger.filter((x) => x && typeof x.url === "string" && typeof x.status === "string").slice(0, MAX_LINK_LEDGER) : undefined;
  const { linkLedger: _ll, linkedPages: _ignored, imageReadings: _ir, imageRefs: _refs, linkMap: _lm, ...rest } = e as StoredEvidence;
  void _lm;
  void _ll;
  void _ignored;
  void _ir;
  void _refs;
  const imageReadings = Array.isArray(e.imageReadings) ? e.imageReadings.filter((r) => r && r.kind === "ai_reading" && typeof r.text === "string" && typeof r.field === "string").slice(0, 12) : undefined;
  const linkMap = Array.isArray(e.linkMap) ? e.linkMap.filter((m) => m && typeof m.short === "string" && typeof m.url === "string").slice(0, 30) : undefined;
  const imageRefs = Array.isArray(e.imageRefs) ? e.imageRefs.filter((u) => typeof u === "string" && u.startsWith("https://")).slice(0, MAX_IMAGE_REFS) : undefined;
  return { ...rest, links: Array.isArray(e.links) ? e.links.slice(0, MAX_EVIDENCE_LINKS) : [], ...(linkedPages?.length ? { linkedPages } : {}), ...(linkLedger?.length ? { linkLedger } : {}), ...(imageReadings?.length ? { imageReadings } : {}), ...(imageRefs?.length ? { imageRefs } : {}), ...(linkMap?.length ? { linkMap } : {}) };
}

/**
 * 再収集で証拠を作り直すとき、**前回の再調査で戻したページ**（recheckSeq>0）を失わない（Phase 2 の監査で発見: 再収集の取得が時間切れ・上限で一部未取得になると、
 * 以前に再調査で取得できていたページが、新しい証拠から消えて「未取得」に戻っていた）。
 *  - 新しい証拠で取得できていないページ（台帳が取得済み以外、または台帳に無い）だけ、前回のページを引き継ぐ。**新しく取得できたページは、新しい方が正**（古い版で上書きしない）。
 *  - 新しい取得が「恒久的に取得できない」（robots・ログイン・404 等）と分かっているページは引き継がない（無くなったページを残さない）。
 *  - 引き継いだページは取得日時が古いまま残る（鮮度が分かる）。台帳は「取得済み」に戻し、引き継いだことを理由に残す（carried）。
 */
const GONE_REASONS = new Set(["robots", "blocked", "not_found", "login_required", "unsafe", "invalid", "social_post", "shortener", "http_error"]);
export function carryOverRechecked(next: StoredEvidence, prior: StoredEvidence | null): StoredEvidence {
  if (!prior || !(prior.recheckSeq && prior.recheckSeq > 0) || !prior.linkedPages?.length) return { ...next, ...(prior?.recheckSeq ? { recheckSeq: prior.recheckSeq } : {}) };
  const have = new Set((next.linkedPages ?? []).map((p) => p.url));
  const ledger = [...(next.linkLedger ?? [])];
  const carried = prior.linkedPages.filter((p) => {
    if (have.has(p.url)) return false;
    const e = ledger.find((x) => x.url === p.url);
    return !(e && e.status !== "fetched" && e.reason && GONE_REASONS.has(e.reason));
  });
  if (carried.length === 0) return { ...next, recheckSeq: prior.recheckSeq };
  const pages = [...(next.linkedPages ?? []), ...carried].slice(0, MAX_LINKED_PAGES);
  const kept = new Set(pages.map((p) => p.url));
  for (const p of carried.filter((x) => kept.has(x.url))) {
    const i = ledger.findIndex((x) => x.url === p.url);
    const e = { url: p.url, key: ledger[i]?.key ?? p.url.replace(/^https?:\/\//, "").slice(0, 300), host: ledger[i]?.host ?? new URL(p.url).hostname, order: ledger[i]?.order ?? 900, origins: p.origins ?? ledger[i]?.origins ?? ["post"], status: "fetched", reason: "carried", ...(p.fullChars ? { chars: p.fullChars } : {}), ...(p.truncated ? { truncated: true } : {}), at: p.fetchedAt };
    if (i >= 0) ledger[i] = e;
    else ledger.push(e);
  }
  return { ...next, linkedPages: pages, linkLedger: ledger.slice(0, MAX_LINK_LEDGER), recheckSeq: prior.recheckSeq };
}
