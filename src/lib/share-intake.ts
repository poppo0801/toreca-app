/**
 * iPhoneの共有（ショートカット）から渡された内容の検証。ブラウザ・サーバー共通の純粋な処理。
 * ショートカットは `/share?url=<URLエンコードしたX投稿のURL>` を開く。ここでは文字列を信用せず、
 * X（旧Twitter）の投稿URLだけを受け付け、標準の形（https://x.com/<ユーザー>/status/<ID>）にそろえる。
 * 将来のX API連携（Stage 4C）でも、この関数が返す投稿IDをそのまま使える。
 */

export type SharedPost = { ok: true; url: string; postId: string; handle: string | null } | { ok: false; message: string };

const MAX_INPUT = 2_000;
const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);

/** 共有された文章からURLらしい部分を取り出す（共有シートは「本文 + URL」の形で渡すことがある） */
function firstUrl(s: string): string | null {
  const m = /https?:\/\/[^\s<>"'「」]+/i.exec(s);
  return m ? m[0].replace(/[)\]}、。，．,.!?！？]+$/, "") : null;
}

export function parseSharedPost(input: { url?: string | null; text?: string | null }): SharedPost {
  const raw = [input.url, input.text].map((v) => (v ?? "").trim()).filter(Boolean);
  if (raw.length === 0) return { ok: false, message: "共有されたURLがありません。X（旧Twitter）の投稿を開いて共有してください" };
  if (raw.some((v) => v.length > MAX_INPUT)) return { ok: false, message: "共有された内容が長すぎます" };
  const candidate = raw.map(firstUrl).find((v): v is string => !!v);
  if (!candidate) return { ok: false, message: "共有された内容にURLが見つかりません" };

  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return { ok: false, message: "URLの形式が正しくありません" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, message: "http(s)のURLだけ受け付けます" };
  if (u.username || u.password || (u.port && u.port !== "443" && u.port !== "80")) return { ok: false, message: "このURLは受け付けられません" };
  if (!X_HOSTS.has(u.hostname.toLowerCase())) return { ok: false, message: "X（旧Twitter）の投稿のURLではありません。Xの投稿から共有してください" };

  // /<ユーザー>/status/<ID>、/i/status/<ID>、/i/web/status/<ID>
  const m = /^\/(?:i\/web|i|([A-Za-z0-9_]{1,15}))\/status(?:es)?\/(\d{5,25})(?:\/|$)/.exec(u.pathname);
  if (!m) return { ok: false, message: "X（旧Twitter）の投稿のURLではありません（投稿ごとのURLを共有してください）" };
  const handle = m[1] ?? null;
  const postId = m[2];
  // 追跡用のクエリ（?s=20&t=... など）は捨てて、標準の形にそろえる
  return { ok: true, url: `https://x.com/${handle ?? "i"}/status/${postId}`, postId, handle };
}

/** ログイン後に戻ってよい場所（オープンリダイレクト対策: 共有の入口だけ） */
export function safeNext(v: unknown): string {
  if (typeof v !== "string" || v.length > 2_500) return "/lotteries";
  if (!/^\/share(\?|$)/.test(v) || /[\\\r\n]/.test(v)) return "/lotteries";
  return v;
}

/** ショートカットで開くURLの前半（この後ろにURLエンコードした投稿URLをつなぐ） */
export const shareLinkPrefix = (origin: string) => `${origin.replace(/\/+$/, "")}/share?url=`;
