/**
 * 収集元のWebページ（まとめサイトの一覧）から、抽選告知へのリンクを取り出す（純粋関数）。
 * 一覧に載っている「外部の告知リンク」（店舗・販売元の公式告知、公式応募ページ、店舗のX投稿）を候補にする。
 * サイトごとの違いはアダプターで吸収し、構造が変わって取れなくなったときは0件として扱う（取れたことにしない）。
 */

import { OTHER_TCG, POKEMON_STRICT, POKEMON_TCG } from "@/lib/collector/category";
export type AdapterId = "pokeso" | "torecabiyori" | "generic";

export interface ListingEntry {
  /** 告知の宛先（正規化済み） */
  url: string;
  kind: "x_post" | "page";
  /** 一覧上の見出し・周辺の文章（関連判定の材料。AIには渡さない） */
  title: string;
  context: string;
  /** リンクを含む1枚のカード（article / li）全体の文章。商品名・店舗名・締切・条件がそろう。カードが特定できなければ未設定 */
  card?: string;
  /** カードの構造から読み取れた店舗名・商品名（サイトごとの決まった位置。読めなければ未設定） */
  fields?: CardFields;
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
  // 抽選の告知ではないページ（カレンダー購読・アプリのダウンロード）
  "calendar.google.com",
  "apps.apple.com",
  "play.google.com",
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

/**
 * リンクを含むカード（article / li）の文章を返す。店舗名・商品名はリンクより前のカード冒頭にあり、
 * タグの属性が長いため「リンク直前の数百文字」では届かない。別のカードに踏み込まないよう、カードが閉じていれば使わない
 */
export function enclosingCardHtml(html: string, start: number, end: number): string | null {
  const head = html.slice(Math.max(0, start - 8000), start);
  let open = -1;
  let tag = "";
  for (const m of head.matchAll(/<(article|li)[\s>]/gi)) {
    open = m.index ?? -1;
    tag = m[1].toLowerCase();
  }
  if (open < 0) return null;
  open += Math.max(0, start - 8000);
  if (html.slice(open, start).toLowerCase().includes(`</${tag}>`)) return null;
  const close = html.toLowerCase().indexOf(`</${tag}>`, end);
  if (close < 0 || close - open > 12000) return null;
  return html.slice(open, close);
}

export function enclosingCard(html: string, start: number, end: number): string | null {
  const raw = enclosingCardHtml(html, start, end);
  const text = raw ? strip(raw) : "";
  return text.length >= 8 ? text.slice(0, 500) : null;
}

/** 一覧のカードの構造から読み取れる店舗名・商品名（文章の並びから推測せず、サイトごとの決まった位置だけを読む） */
export interface CardFields {
  store?: string;
  product?: string;
}

export function cardFields(adapter: AdapterId, rawCard: string): CardFields {
  const clean = (t: string | undefined) => {
    const v = strip(t ?? "").slice(0, 80);
    return v.length >= 2 ? v : undefined;
  };
  if (adapter === "pokeso") {
    // 「商品名 / 店舗名 / 販売価格（定価）¥…」の順に並ぶ。価格の見出しの直前2つの文字列
    const nodes = rawCard.split(/<[^>]+>/).map((n) => strip(n)).filter(Boolean);
    const i = nodes.findIndex((n) => /^(販売価格|定価)$/.test(n));
    if (i >= 2) return { product: clean(nodes[i - 2]), store: clean(nodes[i - 1]) };
    return {};
  }
  if (adapter === "torecabiyori") {
    const store = /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(rawCard)?.[1];
    const product = /<a\b[^>]*href=["']\/chusen\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(rawCard)?.[1];
    return { store: clean(store), product: clean(product) };
  }
  return {};
}

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
    if (!prev) {
      const raw = enclosingCardHtml(html, start, end);
      const card = raw ? enclosingCard(html, start, end) : null;
      const f = raw ? cardFields(adapter, raw) : {};
      seen.set(url, { url, kind, title, context: ctx, ...(card ? { card } : {}), ...(f.store || f.product ? { fields: f } : {}) });
    }
    else if (!prev.title && title) prev.title = title;
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- 関連判定（ルールベース。AIを呼ぶ前の絞り込み）
const POKEMON = POKEMON_TCG;
const OTHER = OTHER_TCG;
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
  const other = OTHER.test(t);
  if (other && !POKEMON_STRICT.test(t)) return { relevant: false, uncertain: false, reason: "ポケモンカード以外のTCGの告知です" };
  if (pk && LOTTERY.test(t)) return { relevant: true, uncertain: false, reason: "" };
  if (pk) return { relevant: true, uncertain: true, reason: "抽選の言及が見当たりません" };
  if (opts.fromPokemonList) return { relevant: true, uncertain: true, reason: "" };
  return { relevant: false, uncertain: true, reason: "ポケモンカードの告知とは判断できません" };
}

export const looksLikeLottery = (text: string) => LOTTERY.test(text.normalize("NFKC"));

// ---------------------------------------------------------------- 一覧の表示から読み取れる情報（AIを呼ぶ前の絞り込み用）
export interface ListHints {
  /** 一覧に表示された応募締切（日本時間のISO。年は現在に最も近いものを採用）。読み取れなければ null */
  deadlineIso: string | null;
  /** 時刻の表示が無い締切（「11/6(金)まで」）の日付 YYYY-MM-DD。時刻は補わない */
  deadlineDate: string | null;
  /** 一覧に表示された都道府県（「千葉県・LivePocket」のような表示）。無ければ空 */
  prefecture: string;
  /** 通販・オンライン・発送の表示がある */
  online: boolean;
}

const PREF_RE = /(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)・/;
const DEADLINE_RES = [
  /(\d{1,2})\/(\d{1,2})(?:\s*[(（][^)）]*[)）])?\s*(\d{1,2}):(\d{2})\s*まで/,
  /締切\s*(\d{1,2})\/(\d{1,2})(?:\s*[(（][^)）]*[)）])?\s*(\d{1,2}):(\d{2})/,
];

/** 月日だけの表示に年を補う: 現在から見て「過去200日〜未来165日」の範囲に入る年を選ぶ */
function inferDate(month: number, day: number, hour: number, minute: number, now: Date): Date | null {
  const y = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric" }).format(now));
  for (const year of [y, y + 1, y - 1]) {
    const d = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`);
    if (Number.isNaN(d.getTime())) continue;
    const diffDays = (d.getTime() - now.getTime()) / 86400_000;
    if (diffDays >= -200 && diffDays <= 165) return d;
  }
  return null;
}

/** 一覧の見出し・周辺の文章から、締切・都道府県・通販の表示を読み取る。読み取れない項目は推測せず空にする */
export function parseListHints(text: string, now: Date): ListHints {
  const t = text.normalize("NFKC");
  let deadline: Date | null = null;
  let deadlineDate: string | null = null;
  for (const re of DEADLINE_RES) {
    const m = re.exec(t);
    if (m) {
      deadline = inferDate(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), now);
      if (deadline) break;
    }
  }
  if (!deadline) {
    // 時刻の表示が無い「11/6(金)まで」は日付だけを使う（23:59などの時刻は補わない）
    const d = /(\d{1,2})\/(\d{1,2})(?:\s*[(（][^)）]*[)）])?\s*まで/.exec(t);
    if (d) {
      const dt = inferDate(Number(d[1]), Number(d[2]), 12, 0, now);
      if (dt) deadlineDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(dt);
    }
  }
  return {
    deadlineIso: deadline ? deadline.toISOString() : null,
    deadlineDate,
    prefecture: PREF_RE.exec(t)?.[1] ?? "",
    online: /通販|オンライン|配送|発送/.test(t),
  };
}
