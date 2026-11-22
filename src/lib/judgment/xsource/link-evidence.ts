/**
 * 応募URLの根拠（出所・展開方式・項目への対応）の記録（Stage 10W・純関数）。「URLの存在」「到達可否」「抽選項目への意味的な適用」を区別し、**推測で埋めない**。
 *  展開方式（method）:
 *   - x_api_entity    : X APIの投稿データ（entities.urls の短縮URL→展開URL。note_tweet の分も）に基づく。**第一候補**（余分なHTTPアクセスをしない）。
 *   - stored_unique_pair: 保存済みの投稿に展開結果（linkMap）が無い場合に限り、**一意に決まる対応だけ**を既存の保存情報から復元する（投稿本文の短縮URLがちょうど1つ・保存された外部リンクがちょうど1つ）。
 *                         決定的な復元で、AIの推測ではない。ただし entity 由来ではないので method に残し、ページと項目の対応（link-scope）の検査は通す。
 *   - none            : 展開結果なし。t.co は robots が拒否するため追跡しない（回避しない）。
 *  項目の範囲（itemRange）・短縮URLの本文中の位置（position）・取得日時・失敗/未実施の理由を保持する。
 */
import type { ListItem } from "../list-items";
import { canonUrl } from "./normalize";

export type ExpansionMethod = "x_api_entity" | "stored_unique_pair" | "none";
export interface LinkEvidenceRecord {
  postId: string;
  itemNo: number;
  /** 項目の本文の範囲（親投稿内の文字位置）。一覧でない投稿は全体 */
  itemRange: { start: number; end: number };
  shortUrl: string | null;
  /** 短縮URLの親投稿本文中の位置（見つからなければ null） */
  position: number | null;
  expandedUrl: string | null;
  method: ExpansionMethod;
  /** 展開結果を記録した日時（収集の取得日時。無ければ null） */
  at: string | null;
  outcome: "expanded" | "unexpanded" | "no_url";
  /** 未展開・URLなしの理由（人が読める短い文）。展開済みなら null */
  reason: string | null;
}

export interface StoredXPostLike {
  postId: string;
  text: string;
  links: string[];
  linkMap?: { short: string; url: string }[];
  recordedAt: string | null;
}

const TCO = /https:\/\/t\.co\/[A-Za-z0-9]+/g;
const isExternal = (u: string): boolean => {
  const c = canonUrl(u);
  return /^https:\/\//.test(u) && c.cls !== "invalid" && c.cls !== "social" && c.cls !== "shortener";
};

/**
 * 項目ごとの展開結果として使う linkMap と、各 short の展開方式。
 * 保存データに linkMap があればそれ（x_api_entity）。無ければ、**一意に決まる場合だけ** stored_unique_pair を復元する。それ以外は復元しない。
 */
export function deriveLinkMap(post: StoredXPostLike): { linkMap: { short: string; url: string }[]; methods: Map<string, ExpansionMethod> } {
  const methods = new Map<string, ExpansionMethod>();
  if (post.linkMap?.length) {
    for (const m of post.linkMap) methods.set(m.short, "x_api_entity");
    return { linkMap: post.linkMap, methods };
  }
  const shorts = [...new Set(post.text.match(TCO) ?? [])];
  const externals = [...new Set(post.links.filter(isExternal))];
  if (shorts.length === 1 && externals.length === 1) {
    methods.set(shorts[0], "stored_unique_pair");
    return { linkMap: [{ short: shorts[0], url: externals[0] }], methods };
  }
  return { linkMap: [], methods };
}

/** 項目ごとのリンクの根拠の記録。URLが無い項目も1件（no_url）として残す（追跡可能にする） */
export function buildLinkEvidence(post: StoredXPostLike, items: ListItem[], methods: Map<string, ExpansionMethod>, linkMap: { short: string; url: string }[]): LinkEvidenceRecord[] {
  const map = new Map(linkMap.map((m) => [m.short, m.url]));
  const out: LinkEvidenceRecord[] = [];
  for (const it of items) {
    const range = { start: it.start, end: it.end };
    const shorts = [...new Set([...it.links.filter((l) => /^https:\/\/t\.co\//.test(l)), ...(it.text.match(TCO) ?? [])])];
    if (!shorts.length) {
      out.push({ postId: post.postId, itemNo: it.no, itemRange: range, shortUrl: null, position: null, expandedUrl: null, method: "none", at: null, outcome: "no_url", reason: "項目の本文に応募先のURLが無い" });
      continue;
    }
    for (const s of shorts) {
      const url = map.get(s);
      const pos = post.text.indexOf(s);
      if (url && /^https:\/\//.test(url)) out.push({ postId: post.postId, itemNo: it.no, itemRange: range, shortUrl: s, position: pos < 0 ? null : pos, expandedUrl: url, method: methods.get(s) ?? "x_api_entity", at: post.recordedAt, outcome: "expanded", reason: null });
      else out.push({ postId: post.postId, itemNo: it.no, itemRange: range, shortUrl: s, position: pos < 0 ? null : pos, expandedUrl: null, method: "none", at: null, outcome: "unexpanded", reason: "展開結果（linkMap）が保存されていない。t.co は robots が拒否するため追跡しない（X APIの展開結果が必要）" });
    }
  }
  return out;
}
