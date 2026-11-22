/**
 * 一覧・まとめ投稿の**全項目**の抽出（Stage 10M）。**純関数のみ。DB・ネットワーク・AIには接続しない**。
 * 保存原文は改行が空白に畳まれているため、見出し（《店舗名（県）- n件》・🏬店舗）と項目の印（空白の直後の ・／✅）で項目に分ける。
 * 各項目に、親投稿内の通し番号・見出し番号・**原文の範囲（文字位置）**・項目内の短縮リンク・締切の表記を持たせる（出典の保持）。
 * 「項目数」と「応募機会の数」は別物: 行数・商品数・店舗数を、そのまま応募機会数にしない（同一応募で複数商品・店舗選択式なら、項目が複数でも応募機会は1つ）。
 */
import { createHash } from "node:crypto";

export interface ListItem {
  /** 親投稿内の通し番号（1始まり） */
  no: number;
  /** 見出し（グループ）の番号（1始まり） */
  groupNo: number;
  /** 見出しの文字列（例: 《店舗名（県）- 1件》） */
  groupLabel: string;
  /** 項目の本文（原文のまま。見出しは含まない） */
  text: string;
  /** 親投稿の本文（保存原文）内の範囲（text の開始・終了位置。slice(start, end) === text） */
  start: number;
  end: number;
  /** 項目内の短縮・外部リンク（URL文字列。判断・保存では値そのものを使わず、親投稿の展開済みリンクとの対応付けにだけ使う） */
  links: string[];
  /** 項目内の締切の表記（例: 11/22(日)23:59）。表示用の手がかりで、判断はAIが原文から行う */
  deadlineHint: string | null;
}

export interface ParsedList {
  isList: boolean;
  /** 冒頭の共通部分（見出し・共通の注意書き）。最大400字 */
  header: string;
  items: ListItem[];
  groups: number;
  /** 親投稿の識別（本文のハッシュ先頭。保存原文が同じなら同じ）。ログ・DBでは原文でなくこれを使う */
  parentKey: string;
}

const HEADER_MAX = 400;
const GROUP_MARK = /《[^》]{2,80}》|🏬/g;
const ITEM_MARK = /(?<=[ \t　])(?=・)|(?<=[ \t　])(?=✅)/g;
const LINK = /https?:\/\/[^\s)）」』]+/g;
const DEADLINE = /(\d{1,2}\/\d{1,2}(?:\([^)]{1,3}\))?\s?\d{1,2}:\d{2})\s?〆?/;

export const parentKeyOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** 一覧を項目に分ける。見出しの印が2つ未満なら一覧ではない（items は空） */
export function parseListItems(text: string): ParsedList {
  const parentKey = parentKeyOf(text);
  const marks = [...text.matchAll(GROUP_MARK)];
  if (marks.length < 2) return { isList: false, header: "", items: [], groups: 0, parentKey };
  const header = text.slice(0, marks[0].index).trim().slice(0, HEADER_MAX);
  const items: ListItem[] = [];
  marks.forEach((m, gi) => {
    const gStart = m.index as number;
    const gEnd = gi + 1 < marks.length ? (marks[gi + 1].index as number) : text.length;
    const body = text.slice(gStart, gEnd);
    const labelEnd = m[0] === "🏬" ? -1 : m[0].length;
    // 見出しの直後から、項目の印で分ける（🏬形式は 🏬店舗名 ✅商品 … の ✅ 以降が項目）
    const cuts: number[] = [];
    for (const c of body.matchAll(ITEM_MARK)) if ((c.index as number) > 0 && (labelEnd < 0 || (c.index as number) >= labelEnd)) cuts.push(c.index as number);
    const firstItemAt = cuts.length ? cuts[0] : labelEnd < 0 ? body.length : labelEnd;
    const label = body.slice(0, labelEnd < 0 ? firstItemAt : labelEnd).trim();
    const bounds = cuts.length ? [...cuts, body.length] : [labelEnd < 0 ? firstItemAt : labelEnd, body.length];
    for (let k = 0; k < bounds.length - 1; k++) {
      const raw = body.slice(bounds[k], bounds[k + 1]);
      const lead = raw.length - raw.trimStart().length;
      const t = raw.trim();
      if (t.replace(/^[・✅\s]+/, "").length < 2) continue;
      const start = gStart + bounds[k] + lead;
      items.push({ no: items.length + 1, groupNo: gi + 1, groupLabel: label, text: t, start, end: start + t.length, links: [...t.matchAll(LINK)].map((x) => x[0]), deadlineHint: DEADLINE.exec(t)?.[1] ?? null });
    }
  });
  return { isList: items.length >= 2, header, items, groups: marks.length, parentKey };
}

/** 判断に渡す塊の本文（共通の見出し＋項目。項目ごとに【項目n】の番号つき。見出し・項目は原文のまま） */
export function composeBatchText(header: string, batch: ListItem[]): string {
  return [header, ...batch.map((it) => `${it.groupLabel} 【項目${it.no}】 ${it.text}`)].filter(Boolean).join(" ");
}

/** 項目を小さな塊（既定は最大6項目・約1,400字）に分ける。項目の順序は保つ。全項目がちょうど1つの塊に入る */
export function batchItems(items: ListItem[], opts: { maxItems?: number; maxChars?: number } = {}): ListItem[][] {
  const maxItems = opts.maxItems ?? 6;
  const maxChars = opts.maxChars ?? 1400;
  const out: ListItem[][] = [];
  let cur: ListItem[] = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= maxItems || chars + it.text.length > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.text.length + it.groupLabel.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

const flat = (s: string): string => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
/** 抜粋が、その項目（または共通の見出し）の本文に実在するか */
export const quoteInItem = (quote: string, item: ListItem, header = ""): boolean => {
  // 判断に渡した塊の本文は「見出し 【項目n】 項目の本文」の並び。抜粋が見出しから項目の本文へまたがる・番号の印を含むことがあるため、印は除いて、
  // 「見出し＋項目の本文」の中に実在すれば採用する（見出しと項目は原文の同じ見出しの下にあり、どちらも親投稿の原文に由来する。原文に無い語句は不採用）
  const q = flat(quote.replace(/【項目[ \t]*[0-9]+】/g, " "));
  return q.length >= 3 && (flat(item.text).includes(q) || flat(item.groupLabel).includes(q) || flat(header).includes(q) || flat(`${item.groupLabel} ${item.text}`).includes(q));
};

/** 項目の範囲が、親投稿の本文と一致しているか（検査用。出典の範囲の保持の確認） */
export const rangeMatches = (parentText: string, item: ListItem): boolean => parentText.slice(item.start, item.end) === item.text;

/**
 * 項目の短縮リンク（t.co）と、親投稿の展開済みリンクの対応表（保存原文の linkMap）から、項目ごとの応募先を求める。
 * 同じ応募先（展開後のURLが同じ）の項目だけを「同一応募」にできる根拠にする。対応表が無い・短縮リンクが表にない項目は、応募先を特定できない（統合しない）。
 */
export function linkResolver(linkMap: { short: string; url: string }[] | undefined): {
  expand: (item: ListItem) => string[];
  sameDestination: (a: ListItem, b: ListItem) => boolean;
  host: (item: ListItem) => string | null;
} {
  const norm = (u: string): string => {
    try {
      const x = new URL(u);
      x.hash = "";
      for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref)/i.test(k)) x.searchParams.delete(k);
      return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}${x.search}`;
    } catch {
      return u;
    }
  };
  const map = new Map((linkMap ?? []).map((m) => [m.short, norm(m.url)]));
  const expand = (item: ListItem): string[] => item.links.map((l) => map.get(l)).filter((x): x is string => !!x);
  return {
    expand,
    sameDestination: (a, b) => {
      const ea = expand(a);
      const eb = new Set(expand(b));
      return ea.some((x) => eb.has(x));
    },
    host: (item) => expand(item)[0]?.split("/")[0] ?? null,
  };
}

/** 一覧でない投稿（単独の告知・抽選でない投稿・画像やリンクが中心の投稿）を、同じ処理の流れに乗せるための「1項目の親投稿」（本文全体が項目1）。見出しは持たない */
export function singleItemParent(text: string): ParsedList {
  const t = text.trim();
  const start = text.indexOf(t);
  const item: ListItem = { no: 1, groupNo: 1, groupLabel: "（単独の投稿）", text: t, start: Math.max(0, start), end: Math.max(0, start) + t.length, links: [...t.matchAll(LINK)].map((x) => x[0]), deadlineHint: DEADLINE.exec(t)?.[1] ?? null };
  return { isList: false, header: "", items: t.length >= 2 ? [item] : [], groups: 1, parentKey: parentKeyOf(text) };
}
