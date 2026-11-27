/**
 * 公開ページのHTMLから、AIに見せる・引用の実在を検証する「本文テキスト」を作る（Stage 10X）。
 * 実AI評価で、タグだけを除いた粗いテキストの先頭1,500字が Google Tag Manager のスクリプトだけになり、AIが原文を見られず「観察」の要約を引用して
 * 引用の検証（原文に実在するか）が通らなかった。スクリプト・スタイル・head・コメントを除き、HTMLエンティティを戻し、空白をまとめる。意味判断はしない（前処理）。
 */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", yen: "¥", hellip: "…", laquo: "«", raquo: "»" };

export function pageText(html: string, o: { keepChrome?: boolean } = {}): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(o.keepChrome ? /<head\b[\s\S]*?<\/head\s*>/gi : /<(head|header|nav|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|dt|dd|table|ul|ol)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t 　]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/**
 * 原文を保ったまま、ページの共通部分（header・nav・footer・aside）の位置を記録する（EVIDENCE_UTILIZATION）。
 *  - 本文 text は除かない整形（keepChrome）と同じ内容。共通部分を削らない（フッターの店舗の所在地・注意、メニュー内の応募リンクを失わない）。
 *  - chrome は、その本文の中で共通部分にあたる字位置の範囲。AIへの提示の側で、関連する行を残して省略し、位置で原文へ戻れるようにする（不可逆に削除しない）。
 */
export function pageTextSections(html: string): { text: string; chrome: { from: number; to: number }[] } {
  const OPEN = "\u0001";
  const CLOSE = "\u0002";
  const marked = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ")
    .replace(/<(?:header|nav|footer|aside)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, `${OPEN}\n`)
    .replace(/<\/(?:header|nav|footer|aside)\s*>/gi, `\n${CLOSE}`);
  const t = pageText(marked, { keepChrome: true });
  let out = "";
  const chrome: { from: number; to: number }[] = [];
  let depth = 0;
  let start = 0;
  for (const ch of t) {
    if (ch === OPEN) {
      if (depth++ === 0) start = out.length;
      continue;
    }
    if (ch === CLOSE) {
      if (depth > 0 && --depth === 0 && out.length > start) chrome.push({ from: start, to: out.length });
      continue;
    }
    out += ch;
  }
  if (depth > 0 && out.length > start) chrome.push({ from: start, to: out.length });
  return { text: out, chrome };
}

const keyOf = (x: string): string => x.normalize("NFKC").replace(/[\s\u3000]+/g, "").toLowerCase();

/**
 * ページの題名（<title>）は「記事名 | サイト名」のように、本文（h1等）には無いサイト名の接尾辞を持つ。<head> は本文に含めないため、題名全体を「本文から欠けた語」とみなすと、
 * 本文に記事名が存在しても欠落と誤判定する（Phase 3 初回3件の案3: 通販サイトの商品ページ）。区切り（｜ | – — と、前後に空白のある -）で分けた区間のうち最も長いものを核として照合する。
 * 本文に核が無ければ従来どおり欠落（検証の基準は緩めない）。
 */
export function titleCore(title: string): string {
  const parts = title.split(/\s*[｜|]\s*|\s+[-–—]\s+/).map((x) => x.trim()).filter((x) => x.length > 0);
  return parts.length <= 1 ? title.trim() : parts.reduce((a, b) => (b.length > a.length ? b : a));
}

/** 保存済みの欠落の記録（60字に切り詰められた語）を、題名の核の規則で再判定する。本文に核が存在すれば欠落ではない */
export function refineTextLoss(loss: readonly string[] | undefined, text: string): string[] {
  if (!loss?.length) return [];
  const k = keyOf(text);
  return loss.filter((l) => !k.includes(keyOf(titleCore(l))));
}

/**
 * 本文の取り出しで、構造として認識できた語（題名・受付枠の名称・「項目: 値」の値）が本文から消えていないかを確認する（本文欠落の見える化）。
 * 既定の整形（メニュー・フッター等を除く）で欠けたら、除かない整形で再度取り出し、欠落の少ない方を使う。それでも欠けるものは `loss` に返す（呼び出し側は保留にする）。
 * 検証の基準は緩めない（引用の実在は、この本文に対して確認する）。
 */
/** 構造として認識できた語のうち、本文に無いもの（pageTextChecked と同じ規則） */
export function missingTerms(text: string, required: string[]): string[] {
  const need = [...new Set(required.map((r) => titleCore(r.trim())).filter((r) => keyOf(r).length >= 3))].slice(0, 40);
  const k = keyOf(text);
  return need.filter((r) => !k.includes(keyOf(r)));
}

export function pageTextChecked(html: string, required: string[]): { text: string; variant: "trimmed" | "full"; loss: string[] } {
  const need = [...new Set(required.map((r) => titleCore(r.trim())).filter((r) => keyOf(r).length >= 3))].slice(0, 40);
  const missing = (t: string): string[] => {
    const k = keyOf(t);
    return need.filter((r) => !k.includes(keyOf(r)));
  };
  const a = pageText(html);
  const ma = missing(a);
  if (ma.length === 0) return { text: a, variant: "trimmed", loss: [] };
  const b = pageText(html, { keepChrome: true });
  const mb = missing(b);
  return mb.length < ma.length ? { text: b, variant: "full", loss: mb } : { text: a, variant: "trimmed", loss: ma };
}
