/**
 * 取得したHTMLから、AI解析に渡す本文を取り出す（依存ライブラリなしの軽量版）。
 * スクリプト・スタイルは除去し、見出し・段落・リストの改行は残す。リンク先は「テキスト → URL」の形で別に集める。
 */

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", yen: "¥", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", copy: "©", reg: "®" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export interface PageText {
  title: string;
  description: string;
  text: string;
  links: { text: string; href: string }[];
  /** 本文が上限で切り詰められた */
  truncated: boolean;
  /** ページのメタ情報から取れた公開日（YYYY-MM-DD）。無ければ空 */
  publishedOn: string;
}

/** ページの公開日（メタタグ・<time>・JSON-LD の datePublished）。見つからなければ空。年の推定の基準に使う */
export function findPublishedOn(html: string): string {
  const keys = ["article:published_time", "og:article:published_time", "pubdate", "date", "DC.date.issued", "datePublished"];
  const cands: string[] = keys.map((k) => meta(html, k));
  cands.push(/<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1] ?? "");
  cands.push(/"datePublished"\s*:\s*"([^"]+)"/i.exec(html)?.[1] ?? "");
  for (const c of cands) {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(c);
    if (m) {
      const y = Number(m[1]);
      if (y >= 2000 && y <= 2100 && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
  return "";
}

function meta(html: string, key: string): string {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  if (!tag) return "";
  return decodeEntities(/content=["']([^"']*)["']/i.exec(tag)?.[1] ?? "").trim();
}

export function extractPageText(html: string, baseUrl: string, maxChars = 20_000): PageText {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim() || meta(html, "og:title");
  const description = meta(html, "og:description") || meta(html, "description");

  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ");

  const links: { text: string; href: string }[] = [];
  body = body.replace(/<a\b[^>]*?href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    try {
      const abs = new URL(decodeEntities(href), baseUrl);
      if ((abs.protocol === "http:" || abs.protocol === "https:") && text && links.length < 40) links.push({ text: text.slice(0, 80), href: abs.toString() });
    } catch {
      // 不正なリンクは無視
    }
    return ` ${text} `;
  });

  body = body
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|dt|dd|table|ul|ol|header|footer|form)>/gi, "\n")
    .replace(/<(li|dt|dd|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  let text = decodeEntities(body)
    .replace(/[ \t　 ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  // 同じ文言の繰り返し（ナビゲーション等）でトークンを使わないよう、連続する同一行は1つにする
  text = text.split("\n").filter((l, i, a) => i === 0 || l !== a[i - 1]).join("\n");
  return { title, description, text, links, truncated, publishedOn: findPublishedOn(html) };
}

/** AIに渡す本文を組み立てる（タイトル・説明・本文・関連リンク） */
export function pageToPrompt(p: PageText): string {
  const parts = [p.title && `【ページタイトル】${p.title}`, p.description && `【説明】${p.description}`, `【本文】\n${p.text}`];
  const keyLinks = p.links.filter((l) => /応募|申込|申し込|エントリー|抽選|詳細|発表|購入|apply|entry/i.test(l.text)).slice(0, 10);
  if (keyLinks.length) parts.push(`【関連リンク】\n${keyLinks.map((l) => `${l.text} → ${l.href}`).join("\n")}`);
  return parts.filter(Boolean).join("\n\n");
}
