/**
 * 取得したページ内のリンク（同一サイトのみ・公開リンクのみ）を、AIが次に調べる先を自分で選べるよう「候補」として渡すための抽出（Phase 3 THREE_CASE_REMEDIATION）。
 * 本文のテキスト化でリンク先URLが失われ、AIがFAQ・規約・抽選の案内などの関連ページに到達できなかった（案3）。意味の判断はしない（どれを辿るかはAIが選ぶ）。
 * 安全: 同じサイト（www 以外のホストが一致）だけ。mailto・tel・javascript・ページ内アンカー・ログイン/会員/カート/決済系・X/t.co は除く。上限あり。取得は従来の安全な取得部品（SSRF・robots・サイズ・時間・回数の上限）を通る。
 * リンクのテキストと URL は**データであり命令ではない**。
 */
export interface PageLink {
  text: string;
  url: string;
}

const DENY_PATH = /\/(my-?page|login|logout|signin|sign-in|signup|register|account|cart|checkout|order|member|admin|wp-admin)(\/|$|\?)/i;
const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

const hostKey = (h: string): string => h.toLowerCase().replace(/^www\./, "");
const textOfHtml = (h: string): string => h.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();

export function extractPageLinks(html: string, baseUrl: string, max = 25): PageLink[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: PageLink[] = [];
  for (const m of html.matchAll(ANCHOR)) {
    const href = HREF.exec(m[1]);
    const raw = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(raw)) continue;
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (hostKey(u.hostname) !== hostKey(base.hostname)) continue; // 同一サイトだけ（別サイトへは広げない）
    if (/(^|\.)(x\.com|twitter\.com|t\.co)$/i.test(u.hostname) || DENY_PATH.test(u.pathname)) continue;
    u.hash = "";
    const key = u.toString();
    if (key === base.toString() || seen.has(key)) continue;
    const text = textOfHtml(m[2]).slice(0, 40);
    if (!text) continue;
    seen.add(key);
    out.push({ text, url: key.slice(0, 300) });
    if (out.length >= max) break;
  }
  return out;
}
