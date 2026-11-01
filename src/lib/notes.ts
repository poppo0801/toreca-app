/**
 * 備考（自由記述）を項目単位に分ける（表示専用。元の文章は変更しない）。
 * 改行・行頭の記号（・ ● ※ - 1. ①など）・文末の「。」で区切る。1項目しかなければ通常の文章として表示する。
 */
const BULLET_RE = /^\s*(?:[・●■◆▪•※*＊\-－ー]\s*|(?:\d{1,2}|[①-⑳])\s*[.．)）、]?\s+|[①-⑳]\s*)/u;

export function splitNotes(text: string): string[] {
  const items: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(BULLET_RE, "").trim();
    if (!line) continue;
    // 「。」で終わる文が複数続くときだけ文単位に分ける（括弧内の「。」では分けない）
    let depth = 0;
    let cur = "";
    for (const ch of line) {
      cur += ch;
      if ("（(「『【".includes(ch)) depth++;
      else if ("）)」』】".includes(ch)) depth = Math.max(0, depth - 1);
      else if (ch === "。" && depth === 0) {
        if (cur.trim()) items.push(cur.trim());
        cur = "";
      }
    }
    if (cur.trim()) items.push(cur.trim());
  }
  return items;
}
