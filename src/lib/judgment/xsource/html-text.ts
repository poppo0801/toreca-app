/**
 * 公開ページのHTMLから、AIに見せる・引用の実在を検証する「本文テキスト」を作る（Stage 10X）。
 * 実AI評価で、タグだけを除いた粗いテキストの先頭1,500字が Google Tag Manager のスクリプトだけになり、AIが原文を見られず「観察」の要約を引用して
 * 引用の検証（原文に実在するか）が通らなかった。スクリプト・スタイル・head・コメントを除き、HTMLエンティティを戻し、空白をまとめる。意味判断はしない（前処理）。
 */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", yen: "¥", hellip: "…", laquo: "«", raquo: "»" };

export function pageText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(head|header|nav|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, " ")
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
