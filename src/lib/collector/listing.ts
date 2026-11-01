/**
 * 収集元のWebページ（まとめサイトの一覧）から、抽選告知へのリンクを取り出す（純粋関数）。
 * 一覧に載っている「外部の告知リンク」（店舗・販売元の公式告知、公式応募ページ、店舗のX投稿）を候補にする。
 * サイトごとの違いはアダプターで吸収し、構造が変わって取れなくなったときは0件として扱う（取れたことにしない）。
 */

export type AdapterId = "pokeso" | "torecabiyori" | "generic";

export interface ListingEntry {
  /** 告知の宛先（正規化済み） */
  url: string;
  kind: "x_post" | "page";
  /** 一覧上の見出し・周辺の文章（関連判定の材料。AIには渡さない） */
  title: string;
  context: string;
}

/** 広告・アフィリエイト・SNS共有・計測などのドメイン（告知ではない） */
const SKIP_HOSTS = [
  "hb.afl.rakuten.co.jp",
  "af.moshimo.com",
  "px.a8.net",
  "www.amazon.co.jp",
  "amzn.to",
  "ad.admitad.com",
  "t.co/share",
  "twitter.com/intent",
  "x.com/intent",
  "x.com/share",
  "line.me/R/",
  "www.facebook.com",
  "b.hatena.ne.jp",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "www.googletagmanager.com",
  "pub-af7de6555fc549da8652a428e1a53e2d.r2.dev",
];

const TRACKING = /^(utm_|fbclid|gclid|igshid|ref$|ref_src|s$|t$)/i;

export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim().replace(/&amp;/g, "&"), base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  u.protocol = "https:";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  if (u.hostname === "twitter.com" || u.hostname === "www.twitter.com" || u.hostname === "mobile.twitter.com" || u.hostname === "www.x.com") u.hostname = "x.com";
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  return s;
}

const isSkipped = (u: string) => SKIP_HOSTS.some((h) => u.replace(/^https?:\/\//, "").startsWith(h));
const X_STATUS = /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}$/;

/** 切り出した断片の先頭・末尾に残った、途中で切れたタグ（属性など）を取り除く */
const trimPartialTags = (h: string) => {
  const firstGt = h.indexOf(">");
  const firstLt = h.indexOf("<");
  let out = firstGt >= 0 && (firstLt < 0 || firstGt < firstLt) ? h.slice(firstGt + 1) : h;
  const lastLt = out.lastIndexOf("<");
  if (lastLt >= 0 && out.indexOf(">", lastLt) < 0) out = out.slice(0, lastLt);
  return out;
};

const strip = (html: string) =>
  trimPartialTags(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** 一覧ページのHTMLから外部リンクの候補を取り出す。同じ宛先は1件にまとめる */
export function parseListing(adapter: AdapterId, html: string, baseUrl: string): ListingEntry[] {
  let self = "";
  try {
    self = new URL(baseUrl).hostname.replace(/^www\./, "");
  } catch {
    return [];
  }
  const seen = new Map<string, ListingEntry>();
  const re = /<a\b[^>]*?href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  const found = [...html.matchAll(re)];
  for (let i = 0; i < found.length; i++) {
    const m = found[i];
    const url = normalizeUrl(m[2], baseUrl);
    if (!url || isSkipped(url)) continue;
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    // 自サイト内のリンクは告知ではない（アダプター別の詳細ページ対応が必要な場合はここで拡張する）
    if (host === self || host.endsWith(`.${self}`)) continue;
    if (adapter === "torecabiyori" && /(^|\.)(rakuten|moshimo|a8)\./.test(host)) continue;
    if (/\.(png|jpe?g|gif|webp|svg|css|js|ico|pdf)(\?|$)/i.test(url)) continue;
    const kind = X_STATUS.test(url) ? "x_post" : "page";
    // X のプロフィール・検索・ハッシュタグ等は告知そのものではない
    if (host === "x.com" && kind !== "x_post") continue;
    const title = strip(m[3]).slice(0, 120);
    // 周辺の文章は、隣のリンクの範囲に入り込まない（別の告知の文言が混ざらないように）
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const prevEnd = i > 0 ? (found[i - 1].index ?? 0) + found[i - 1][0].length : 0;
    const nextStart = i + 1 < found.length ? (found[i + 1].index ?? html.length) : html.length;
    const ctx = strip(html.slice(Math.max(prevEnd, start - 400), Math.min(nextStart, end + 200))).slice(-360);
    const prev = seen.get(url);
    if (!prev) seen.set(url, { url, kind, title, context: ctx });
    else if (!prev.title && title) prev.title = title;
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- 関連判定（ルールベース。AIを呼ぶ前の絞り込み）
const POKEMON = /ポケモンカード|ポケカ|ポケモン\s*(TCG|カード)|Pok[eé]mon\s*(TCG|Card)|拡張パック|ハイクラスパック|強化拡張パック|スタートデッキ|スターターセット|exスペシャル|スペシャルセット/i;
const OTHER_TCG = /遊戯王|遊★戯★王|ワンピースカード|ONE\s*PIECE\s*CARD|デュエル・?マスターズ|デュエマ|ヴァイスシュヴァルツ|Weiß|MTG|マジック[：:・]?ザ・?ギャザリング|ドラゴンボール(スーパー)?カード|ガンダムカード|ユニオンアリーナ|バトルスピリッツ|ヴァンガード|ディズニー.*カード|Lorcana|ホロライブ.*カード/i;
const LOTTERY = /抽選|応募|受付|予約|販売|招待|エントリー|当選|申込|申し込み/;

export interface Relevance {
  relevant: boolean;
  /** 判断できなかった（キーワードが無い）。一覧由来ならAIに任せる */
  uncertain: boolean;
  reason: string;
}

/** ポケモンカードの抽選告知らしいか。ポケモンカード以外のTCGが主題なら除外。何も手掛かりが無ければ uncertain */
export function judgeRelevance(text: string, opts: { fromPokemonList?: boolean } = {}): Relevance {
  const t = text.normalize("NFKC");
  const pk = POKEMON.test(t);
  const other = OTHER_TCG.test(t);
  if (other && !pk) return { relevant: false, uncertain: false, reason: "ポケモンカード以外のTCGの告知です" };
  if (pk && LOTTERY.test(t)) return { relevant: true, uncertain: false, reason: "" };
  if (pk) return { relevant: true, uncertain: true, reason: "抽選の言及が見当たりません" };
  if (opts.fromPokemonList) return { relevant: true, uncertain: true, reason: "" };
  return { relevant: false, uncertain: true, reason: "ポケモンカードの告知とは判断できません" };
}

export const looksLikeLottery = (text: string) => LOTTERY.test(text.normalize("NFKC"));
