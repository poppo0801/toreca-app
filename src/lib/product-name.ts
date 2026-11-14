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

/**
 * 販売条件・数量の語（Stage 9C）。商品そのものではない付帯情報（「シュリンクなし」「1人2個まで」「特典付き」など）。
 * 括弧書きの中身がすべてこれらの語だけのときに、商品名から分離する（商品を区別する語「特別版」「ex」などは含めない）。
 */
const CONDITION_TOKEN = /^(?:シュリンク(?:なし|無し|あり|有り|付き?|未開封)?|未開封|新品|未使用|開封済み?|特典(?:付き?|なし|無し|あり|有り)?|封入特典|限定|予約(?:受付)?|定価(?:販売)?|通常(?:版)?販売|送料(?:無料|込み?)|在庫(?:限り|あり)|先着|抽選(?:販売)?|\d+(?:box|ボックス|個|点|パック|セット|枚|カートン)(?:まで|限り|限定|入り?|セット)?|(?:お?1?人|1人|おひとり様|お一人様|1会員)\d*(?:box|ボックス|個|点|セット)?(?:まで|限り|限定)?|\d+(?:box|ボックス|個|点)?(?:まで))$/i;
const BRACKET_RE = /[（(［\[【]([^）)］\]】]{1,40})[）)］\]】]/g;
const isConditionText = (t: string): boolean => {
  const toks = t.split(/[・、,，\s/／+＋]+/).map((x) => x.trim()).filter(Boolean);
  return toks.length > 0 && toks.every((x) => CONDITION_TOKEN.test(x));
};

export interface ProductNameParts {
  /** 販売条件・数量の語（シュリンクなし・1人2個まで など）。商品名には含めない */
  conditions: string[];
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
  const conditions: string[] = [];
  s = s.replace(BRACKET_RE, (m, inner: string) => {
    if (!isConditionText(inner)) return m;
    conditions.push(inner.trim());
    removed.push(m);
    return " ";
  });
  // 括弧のない末尾の販売条件（「ハドウシーカー シュリンクなし」）
  for (;;) {
    const t = s.match(/\s+(\S{2,16})$/);
    if (!t || !CONDITION_TOKEN.test(t[1])) break;
    conditions.push(t[1]);
    removed.push(t[1]);
    s = s.slice(0, s.length - t[0].length).trim();
  }
  s = s.replace(/\s+/g, " ").trim();
  const q =s.match(/[『「]([^』」]{2,60})[』」]/);
  return { cleaned: s, quoted: q ? q[1].trim() : "", removed, conditions };
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
  // 商品区分・シリーズ名（MEGA・拡張パックなど）だけが前に付くときは、本体名だけの候補も加える（「MEGA 拡張パック ハドウシーカー」→「ハドウシーカー」）
  const body = parts.cleaned.replace(/^(?:(?:mega|メガ|スカーレット&バイオレット|スカーレットバイオレット|sv)\s*)?(?:(?:強化|ハイクラス|スペシャル)?拡張パック|ハイクラスパック|スペシャルパック)\s*/i, "").trim();
  if (body && body !== parts.cleaned && body.length >= 2) out.push(body);
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
