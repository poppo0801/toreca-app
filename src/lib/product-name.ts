/**
 * 告知に書かれた商品名の整理（Stage 7A・純関数）。
 * 「【再販】ポケモンカード MEGA 拡張パック『30th CELEBRATION』」のような、装飾語・ブランド名・商品区分を含む文章全体を、
 * 商品名の候補（「30th CELEBRATION」）に整理する。商品マスターとの照合の前処理にだけ使い、整理した名称がマスターに一致したときだけ既存商品に紐づける。
 *
 * 取り除くのは「商品を区別しない語」だけ:
 *   【再販】【予約】【抽選】などの募集状況の印／「11/13発売」などの発売日表記／ブランド名の接頭辞（ポケモンカードゲーム）
 * 取り除かない（商品を区別する語）: 通常版・特別版・スペシャル・プレミアム・限定・BOX・パック・デッキ・セット など
 */
import { normName } from "@/lib/norm";

/** 募集状況・販売形態を表す括弧書きの印（これだけを除く。【特別版】のように商品を区別する括弧は残す） */
const MARKER_WORDS = ["再販", "再入荷", "予約", "予約受付", "抽選", "抽選販売", "抽選受付", "先着", "受付中", "新発売", "新商品", "発売決定", "発売記念", "追加", "追加抽選", "第2弾", "第二弾", "店頭", "通販", "オンライン", "web", "ネット"];
const MARKER_RE = new RegExp(`[【\\[［]\\s*(?:${MARKER_WORDS.join("|")})(?:\\s*[・/／]\\s*(?:${MARKER_WORDS.join("|")}))*\\s*[】\\]］]`, "gi");
/** 発売日表記（「11/13発売」「11月13日発売」「発売日11/13」） */
const RELEASE_RE = /(?:\d{1,2}\s*[/月]\s*\d{1,2}\s*日?\s*(?:\(.\))?\s*発売(?:予定)?|発売日\s*[:：]?\s*\d{1,2}\s*[/月]\s*\d{1,2}\s*日?)/g;
/** ブランド名の接頭辞 */
const BRAND_RE = /^(?:ポケモンカードゲーム|ポケモンカード|ポケカ|pokemoncardgame)\s*/i;

export interface ProductNameParts {
  /** 装飾語を除いた商品名（元が整理不要ならそのまま） */
  cleaned: string;
  /** 括弧『』「」で囲まれた名称（商品名の本体）。なければ空 */
  quoted: string;
  /** 取り除いた語（履歴・表示用） */
  removed: string[];
}

export function splitProductName(raw: string): ProductNameParts {
  const removed: string[] = [];
  let s = raw.normalize("NFKC").trim();
  s = s.replace(MARKER_RE, (m) => (removed.push(m), " "));
  s = s.replace(RELEASE_RE, (m) => (removed.push(m), " "));
  s = s.replace(/\s+/g, " ").trim();
  const brand = s.match(BRAND_RE);
  if (brand) {
    removed.push(brand[0].trim());
    s = s.slice(brand[0].length).trim();
  }
  const q = s.match(/[『「]([^』」]{2,60})[』」]/);
  return { cleaned: s, quoted: q ? q[1].trim() : "", removed };
}

/**
 * 照合に使う商品名の候補（優先順）。元の名称・装飾語を除いた名称・括弧内の本体名。
 * 括弧内の本体名は、括弧の外側が「ブランド名・商品区分」だけのときに限る（「ポケモンカード MEGA 拡張パック『30th CELEBRATION』」→「30th CELEBRATION」）。
 * 外側に商品を区別する語（特別版など）が残るときは、本体名だけに縮めない。
 */
const GENERIC_OUTSIDE = /^(?:mega|メガ|スカーレット&バイオレット|スカーレットバイオレット|sv|拡張パック|強化拡張パック|ハイクラスパック|スペシャルパック|ex|スターターセット|[\s・:：\-ー~〜／/])*$/i;
export function productNameCandidates(raw: string): string[] {
  const parts = splitProductName(raw);
  const out: string[] = [raw.trim()];
  if (parts.cleaned && parts.cleaned !== raw.trim()) out.push(parts.cleaned);
  if (parts.quoted) {
    const outside = parts.cleaned.replace(/[『「][^』」]*[』」]/, "");
    if (GENERIC_OUTSIDE.test(normName(outside).replace(/[()（）]/g, ""))) out.push(parts.quoted);
  }
  return [...new Set(out.filter(Boolean))];
}

/** 表示・新規候補に使う整理後の名称（本体名が取れるときは本体名、なければ装飾語を除いた名称。変化がなければ元の名称） */
export function tidyProductName(raw: string): string {
  const c = productNameCandidates(raw);
  return c[c.length - 1] ?? raw.trim();
}
