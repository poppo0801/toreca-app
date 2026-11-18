/**
 * 判断履歴に保存する文面の伏せ字・切り詰め（Stage 9H-3B・純関数）。
 * APIキー・認証情報・メールアドレス・電話番号・郵便番号つきの住所らしき文字列を保存しない。保存は短い抜粋と要約値（件数・ハッシュ）に限る。
 */
import { createHash } from "node:crypto";

const PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{8,}/g, "[キー]"],
  [/(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[認証情報]"],
  [/(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*\S+/gi, "[認証情報]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[メール]"],
  // 住所（郵便番号から後ろ）を電話番号より先に伏せる（郵便番号が電話番号の形に誤って一致しないように）
  [/〒\s?\d{3}-\d{4}[^\n]{0,40}/g, "[住所]"],
  [/(?<![\d-])0\d{1,4}-\d{1,4}-\d{3,4}(?![\d-])/g, "[電話]"],
  [/(?<!\d)0[789]0\d{8}(?!\d)/g, "[電話]"],
];

export function redact(text: string): string {
  let t = text;
  for (const [re, rep] of PATTERNS) t = t.replace(re, rep);
  return t;
}

/** 伏せ字にしてから、先頭 max 文字だけを残す */
export function excerpt(text: string, max: number): string {
  const t = redact(text.replace(/\s+/g, " ").trim());
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** AIへ渡した入力の記録（保存用）。本文は短い抜粋のみ。全文はハッシュと長さで同一性だけを追えるようにする */
export interface AiInputRecord {
  kind: string;
  sourceUrl: string;
  textLength: number;
  textDigest: string;
  textExcerpt: string;
  imageCount: number;
  /** 本文のほかにAIへ渡した参考情報の見出し（表示名・プロフィール・過去の人間の判断など）。内容は伏せ字のうえ短縮 */
  context: string[];
  postedOn?: string;
}

export const EXCERPT_CHARS = 1200;
export const CONTEXT_ITEM_CHARS = 200;
export const CONTEXT_MAX_ITEMS = 8;

export function aiInputRecord(o: { kind: string; sourceUrl?: string; text?: string; imageCount?: number; context?: string[]; postedOn?: string }): AiInputRecord {
  const text = o.text ?? "";
  return {
    kind: o.kind,
    sourceUrl: redact((o.sourceUrl ?? "").slice(0, 300)),
    textLength: text.length,
    textDigest: digest(text),
    textExcerpt: excerpt(text, EXCERPT_CHARS),
    imageCount: o.imageCount ?? 0,
    context: (o.context ?? []).slice(0, CONTEXT_MAX_ITEMS).map((c) => excerpt(c, CONTEXT_ITEM_CHARS)),
    ...(o.postedOn ? { postedOn: o.postedOn } : {}),
  };
}
