/**
 * 新AIシャドーのジョブの原文ハッシュ（EVIDENCE_UTILIZATION）。
 *  - 以前は投稿本文のハッシュ（evidence.hash・32桁）だけで重複を判定していた。そのため、同じ本文で取得したリンク先・画像が増えた・変わった場合
 *    （未取得リンクの再調査の成功など）、新しい証拠が新AIへ届かなかった。
 *  - 新形式のジョブのハッシュ（40桁）= 本文のハッシュの先頭24桁 ＋ 素材（リンク先ページ・画像の参照）の正規化ハッシュ16桁。
 *    表示の微差（残り日数・閲覧数など）は normalizeForHash で除き、意味のある変化だけで新しいジョブになる。
 *  - 旧形式（本文のハッシュ32桁そのもの）のジョブとは桁数で区別し、本文の先頭24桁で同じ本文と判定できる。
 */
import { createHash } from "node:crypto";
import type { StoredEvidence } from "./evidence";
import { normalizeForHash } from "./queue";

export const SHADOW_TEXT_PREFIX = 24;
export const SHADOW_JOB_HASH_LEN = 40;
const h = (s: string): string => createHash("sha256").update(s).digest("hex");

type Ev = Pick<StoredEvidence, "hash" | "linkedPages" | "imageRefs">;

/** リンク先ページ（URL・正規化した本文・全文の字数）と画像の参照の集合から、16桁の素材ハッシュを作る。並び順には依存しない */
export function materialHashOf(ev: Pick<StoredEvidence, "linkedPages" | "imageRefs">): string {
  const pages = (ev.linkedPages ?? []).map((p) => `${p.url}\u0000${h(normalizeForHash(p.text)).slice(0, 16)}\u0000${p.fullChars ?? p.text.length}`).sort();
  const images = [...new Set(ev.imageRefs ?? [])].sort();
  return h(JSON.stringify({ pages, images })).slice(0, 16);
}

/** シャドーのキューへ入れるハッシュ（新形式・40桁）。本文のハッシュが無ければ null */
export function shadowJobHash(ev: Ev | null | undefined): string | null {
  if (!ev?.hash || !/^[0-9a-f]{32,64}$/.test(ev.hash)) return null;
  return ev.hash.slice(0, SHADOW_TEXT_PREFIX) + materialHashOf(ev);
}

export const isNewFormatJobHash = (x: string): boolean => x.length === SHADOW_JOB_HASH_LEN;

/**
 * ジョブのハッシュと、いまの証拠の関係。
 *  - same: 本文も素材も同じ（旧形式は本文が同じ）
 *  - material_changed: 本文は同じだが、素材がジョブの作成後に変わった
 *  - stale: 本文が変わった
 */
export function jobEvidenceRelation(jobHash: string, ev: Ev): "same" | "material_changed" | "stale" {
  if (!isNewFormatJobHash(jobHash)) return ev.hash.startsWith(jobHash) ? "same" : "stale";
  if (jobHash.slice(0, SHADOW_TEXT_PREFIX) !== ev.hash.slice(0, SHADOW_TEXT_PREFIX)) return "stale";
  return jobHash.slice(SHADOW_TEXT_PREFIX) === materialHashOf(ev) ? "same" : "material_changed";
}

/** 2つのジョブのハッシュの比較: 本文が違う／素材だけが違う（両方が新形式のときだけ判定できる）／同じ・判定できない */
export function jobHashDiff(a: string, b: string): "content" | "material" | null {
  if (a.slice(0, SHADOW_TEXT_PREFIX) !== b.slice(0, SHADOW_TEXT_PREFIX)) return "content";
  if (isNewFormatJobHash(a) && isNewFormatJobHash(b) && a !== b) return "material";
  return null;
}
