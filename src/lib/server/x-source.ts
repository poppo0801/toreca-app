import "server-only";
import { decodeEntities } from "@/lib/ai/page-text";
import { safeFetch } from "@/lib/server/safe-fetch";

/**
 * X（旧Twitter）の投稿URLから本文を取得する。
 * 利用するのは公式の公開エンドポイント「publish.x.com/oembed」（旧 publish.twitter.com は publish.x.com へ転送される）だけ（APIキー・契約・課金は不要）。
 * 非公開アカウント・削除済み・年齢制限・取得制限の投稿、引用や画像だけの投稿は取得できないことがある。
 * 不安定なスクレイピングや、ログイン・制限の回避は行わない。取得できないときは文章・画像の入力へ案内する。
 */

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);

export function parseXStatusUrl(raw: string): { user: string; id: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!X_HOSTS.has(u.hostname.toLowerCase())) return null;
  const m = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})(?:\/|$)/.exec(u.pathname);
  return m ? { user: m[1], id: m[2] } : null;
}

export function isXHost(raw: string): boolean {
  try {
    return X_HOSTS.has(new URL(raw.trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** oEmbed の html（blockquote）から投稿本文とリンクを取り出す */
const EN_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** 投稿日（oEmbedの日付リンク）。「2026年10月5日」または「October 5, 2026」。無ければ空 */
export function parseOembedDate(html: string): string {
  const tail = html.slice(html.lastIndexOf("&mdash;") >= 0 ? html.lastIndexOf("&mdash;") : 0);
  const ja = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/.exec(tail);
  if (ja) return `${ja[1]}-${ja[2].padStart(2, "0")}-${ja[3].padStart(2, "0")}`;
  const en = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(tail);
  const mi = en ? EN_MONTHS.indexOf(en[1].toLowerCase()) : -1;
  return en && mi >= 0 ? `${en[3]}-${String(mi + 1).padStart(2, "0")}-${en[2].padStart(2, "0")}` : "";
}

export function parseOembedHtml(html: string): { text: string; links: string[]; author: string } {
  const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] ?? "";
  const links = [...p.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1])).filter((h) => /^https?:\/\//i.test(h));
  const text = decodeEntities(p.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").trim();
  const author = decodeEntities(/&mdash;\s*([^<(]+)/i.exec(html)?.[1] ?? "").trim();
  return { text, links, author };
}

/** 公開oEmbed経路で展開する短縮リンクの上限と時間（旧: 先頭3件だけを無言で展開し、4件目以降は消えていた。Phase 2 の調査で発見）。上限を超えた分・展開できなかった分は「展開できなかった短縮リンク」として本文に残る */
export const OEMBED_EXPAND_MAX = 12;
export const OEMBED_EXPAND_TOTAL_MS = 20_000;

/**
 * 投稿内のリンクを展開する（t.co は最初の Location だけを取得。本文は取得しない）。順序は元の順序を保つ。
 * 展開できなかった（上限超過・時間切れ・失敗）短縮リンクは unexpanded に残し、**無言で捨てない**。
 */
export async function expandPostLinks(links: readonly string[], o: { max?: number; totalMs?: number; concurrency?: number; fetchImpl?: typeof safeFetch; now?: () => number } = {}): Promise<{ expanded: string[]; unexpanded: string[] }> {
  const max = o.max ?? OEMBED_EXPAND_MAX;
  const doFetch = o.fetchImpl ?? safeFetch;
  const now = o.now ?? Date.now;
  const deadline = now() + (o.totalMs ?? OEMBED_EXPAND_TOTAL_MS);
  const uniq = [...new Set(links)];
  const slots: (string | null)[] = uniq.map((l) => (/^https?:\/\/t\.co\//i.test(l) ? null : l));
  const unexpanded: string[] = [];
  const todo = uniq.map((l, i) => ({ l, i })).filter((x) => slots[x.i] === null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const k = next++;
      if (k >= todo.length) return;
      const { l, i } = todo[k];
      if (k >= max || now() >= deadline) {
        unexpanded.push(l);
        continue;
      }
      const r = await doFetch(l, { noFollow: true, timeoutMs: 4_000, accept: ["text/html", "text/plain"] }).catch(() => null);
      if (r && r.ok && r.finalUrl && r.finalUrl !== l) slots[i] = r.finalUrl;
      else unexpanded.push(l);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 3) }, worker));
  return { expanded: [...new Set(slots.filter((x): x is string => !!x))], unexpanded };
}

export type XFetchResult = { ok: true; text: string; author: string; notice: string[]; postedOn: string } | { ok: false; message: string };

export async function fetchXPost(rawUrl: string): Promise<XFetchResult> {
  const parsed = parseXStatusUrl(rawUrl);
  if (!parsed) return { ok: false, message: "Xの投稿URL（https://x.com/ユーザー名/status/数字）を入力してください" };
  const canonical = `https://twitter.com/${parsed.user}/status/${parsed.id}`;
  const api = `https://publish.x.com/oembed?omit_script=1&dnt=true&lang=ja&url=${encodeURIComponent(canonical)}`;
  const res = await safeFetch(api, { accept: ["application/json"], timeoutMs: 8_000, maxBytes: 200_000 });
  if (!res.ok) {
    const why =
      res.code === "http_error"
        ? "この投稿は公開されていないか、取得が制限されています（非公開・削除・取得制限など）"
        : "Xの投稿を取得できませんでした";
    return { ok: false, message: `${why}。投稿の文章をコピーして貼り付けるか、スクリーンショットを読み取ってください` };
  }
  let html = "";
  try {
    html = String((JSON.parse(res.body) as { html?: unknown }).html ?? "");
  } catch {
    return { ok: false, message: "Xから想定外の応答が返りました。投稿の文章をコピーして貼り付けてください" };
  }
  const post = parseOembedHtml(html);
  if (!post.text) return { ok: false, message: "投稿の本文を取得できませんでした。文章をコピーするか、スクリーンショットを読み取ってください" };

  // 短縮URL(t.co)は展開して、告知の本当の宛先をAIに伝える（リダイレクト先はURL文字列としてだけ使い、本文は取得しない）
  const { expanded, unexpanded } = await expandPostLinks(post.links);
  const notice = ["Xの投稿に添付された画像は取得できません。告知が画像の場合は、スクリーンショットを読み取ってください"];
  const text = [`【Xの投稿】${post.author ? `（${post.author}）` : ""}`, post.text, expanded.length ? `\n【投稿内のリンク】\n${expanded.join("\n")}` : "", unexpanded.length ? `\n【展開できなかった短縮リンク（${unexpanded.length}件）】\n${unexpanded.join("\n")}` : ""].filter(Boolean).join("\n");
  return { ok: true, text, author: post.author, notice, postedOn: parseOembedDate(html) };
}
