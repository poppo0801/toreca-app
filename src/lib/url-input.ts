// AI読み取りのURL入力: 形式の判定と取得方式の判別（情報源の公式性・信頼性の評価とは別。ここでは公式かどうかを判断しない）。
// 純粋関数のみ（サーバー・ブラウザの両方で使う）。

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
/** 短縮URL。転送先を確認してから取得方式を選ぶ（本文は取得しない） */
const SHORTENER_HOSTS = new Set(["t.co", "bit.ly", "buff.ly", "ow.ly", "goo.gl", "tinyurl.com", "is.gd", "lin.ee", "amzn.to", "fb.me", "j.mp"]);

export type UrlInputKind = "x" | "web";

export type UrlInputClass = { ok: true; url: string; kind: UrlInputKind; host: string; shortened: boolean } | { ok: false; message: string };

export function classifyUrlInput(raw: string): UrlInputClass {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, message: "URLを入力してください" };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, message: "URLの形式が正しくありません（https:// から始まるURLを入力してください）" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, message: "http(s)のURLのみ指定できます" };
  if (u.username || u.password) return { ok: false, message: "認証情報を含むURLは取得できません" };
  if (text.length > 2000) return { ok: false, message: "URLが長すぎます" };
  const host = u.hostname.toLowerCase();
  return { ok: true, url: text, kind: X_HOSTS.has(host) ? "x" : "web", host, shortened: SHORTENER_HOSTS.has(host) };
}
