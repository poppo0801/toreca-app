/**
 * AIへの提示用の「関連情報ビュー」（EVIDENCE_UTILIZATION §2。原文は変えない）。
 *  - 保存・引用の検証・read の対象は、常に原文（共通部分を含む全文）。ここで作るのは、AIの入力に載せる見せ方だけ。
 *  - ページの共通部分（header・nav・footer・aside。DOMの意味で判定し、店舗ごとの規則を持たない）のうち、
 *    所在地・応募・抽選・受付・条件・注意などの語を含む行は残し、その他の行（メニュー項目・著作権表示など）を位置つきの印に置き換える。
 *  - 省略した範囲・字数・理由を印に明示し、AIは read（位置・字数）で原文をいつでも確認できる。
 *  - 省略が小さい（200字未満）・共通部分が本文の大半（90%超。構造の判定が信用できない）なら使わない（全文のまま）。
 *  - 方式の切り替え: PAGE_VIEW_MODE = legacy（以前の動作: 取り出しの段階で共通部分を削る）／full（全文）／related（この関連情報ビュー）。
 */
export type PageViewMode = "legacy" | "full" | "related";

/**
 * 既定の方式。CAPABILITY_CEILING（利用者の方針 2026-11-27: 不要な文字の削減は後回し。AIへの提示も原則は全文＋必要時の read）により full に戻した。
 * related（関連情報ビュー）は比較用に残す（PAGE_VIEW_MODE=related）。共通部分の範囲の記録（structure.chrome）は保存を続ける
 */
export const DEFAULT_PAGE_VIEW_MODE: PageViewMode = "full";

export function pageViewMode(env: Record<string, string | undefined> | undefined = typeof process !== "undefined" ? process.env : undefined): PageViewMode {
  const v = env?.PAGE_VIEW_MODE;
  return v === "legacy" || v === "full" || v === "related" ? v : DEFAULT_PAGE_VIEW_MODE;
}

/** 共通部分の中でも残す行（所在地・連絡先・応募・受付・条件・注意・対象商品）。意味判断ではなく、見せる行を選ぶ目印（網羅は read で担保） */
export const CHROME_KEEP = /(〒|住所|所在地|\S{1,4}[都道府県]\S{0,12}[市区町村郡]|TEL|Tel|tel|電話|営業時間|定休|アクセス|応募|抽選|受付|申込|申し込|予約|販売|発売|注意|条件|規約|会員|ログイン|店舗|ポケモン|ポケカ|BOX|ボックス|パック|締切|期間|発表|当選|引換|受取|発送|通販|オンライン)/;
const KEEP_LINE_MAX = 200;
export const MIN_OMIT_CHARS = 200;

export interface CompactView {
  excerpt: string;
  /** 原文のうち、提示した範囲（字位置） */
  shown: { from: number; to: number }[];
  omitted: { from: number; to: number }[];
  shownChars: number;
  omittedChars: number;
}

export function compactView(text: string, chrome: readonly { from: number; to: number }[]): CompactView | null {
  const ranges = [...chrome].filter((r) => r.to > r.from && r.from >= 0 && r.to <= text.length).sort((a, b) => a.from - b.from);
  if (!ranges.length) return null;
  const chromeChars = ranges.reduce((s, r) => s + (r.to - r.from), 0);
  if (chromeChars > text.length * 0.9) return null;
  const omitted: { from: number; to: number }[] = [];
  for (const r of ranges) {
    let at = r.from;
    for (const line of text.slice(r.from, r.to).split("\n")) {
      const from = at;
      const to = at + line.length;
      at = to + 1;
      const keep = line.trim().length > 0 && line.length <= KEEP_LINE_MAX && CHROME_KEEP.test(line);
      if (keep || line.trim().length === 0) continue;
      const last = omitted[omitted.length - 1];
      // 間が空行・改行だけなら、続けて1つの省略にまとめる
      if (last && /^\s*$/.test(text.slice(last.to, from))) last.to = Math.min(to, r.to);
      else omitted.push({ from, to: Math.min(to, r.to) });
    }
  }
  const omittedChars = omitted.reduce((s, r) => s + (r.to - r.from), 0);
  if (omittedChars < MIN_OMIT_CHARS) return null;
  let excerpt = "";
  const shown: { from: number; to: number }[] = [];
  let cur = 0;
  for (const o of omitted) {
    if (o.from > cur) {
      excerpt += text.slice(cur, o.from);
      shown.push({ from: cur, to: o.from });
    }
    excerpt += `［${o.from}〜${o.to}字目: ページの共通部分（メニュー・ヘッダー・フッター等）${o.to - o.from}字を省略。read で原文を確認できる］`;
    cur = o.to;
  }
  if (cur < text.length) {
    excerpt += text.slice(cur);
    shown.push({ from: cur, to: text.length });
  }
  return { excerpt, shown, omitted, shownChars: text.length - omittedChars, omittedChars };
}
