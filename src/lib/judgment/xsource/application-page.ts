/**
 * 応募先ページの調査の部品（Stage 10R・純関数）。公開ページの取得そのもの（SSRF・robots・リダイレクト・サイズ・時間の制限）は既存の安全な取得部品が担い、ここでは
 * 「どのURLを候補にするか」「取得失敗の原因の分類」「ページから応募単位に関わる観察を抜き出す」を扱う。**ログイン・CAPTCHAの回避、フォームの送信、非公開データの取得はしない**（取得できなければ未確認として扱い、推測で埋めない）。
 */
import { canonUrl } from "./normalize";

export type FetchFailure = "robots" | "login_required" | "not_found" | "timeout" | "private_or_blocked" | "cap" | "other";

/** 取得失敗の原因の分類（メッセージの文面から。分類不能は other） */
export function classifyFetchFailure(message: string): FetchFailure {
  const m = message.normalize("NFKC");
  if (/robots|ロボット/i.test(m)) return "robots";
  if (/ログイン|login|認証|401|403/i.test(m)) return "login_required";
  if (/404|見つかりません|not found/i.test(m)) return "not_found";
  if (/タイムアウト|timeout|時間/i.test(m)) return "timeout";
  if (/内部|プライベート|ループバック|SSRF|許可されない|private|blocked/i.test(m)) return "private_or_blocked";
  return "other";
}

export interface ApplyUrlCandidate {
  url: string;
  /** item=項目自身のリンク（短縮URLを含む。展開して辿る）／parent=親投稿に付いていた展開済みのリンク（親投稿の全項目に共通） */
  scope: "item" | "parent";
  cls: "specific" | "generic" | "shortener";
}

/** 応募先ページの候補URL（https・公開）。SNSの投稿URL・X/Twitterは対象外（ログインが要るため）。短縮URLは項目自身のリンクだけ（展開して辿る） */
export function candidateApplyUrls(a: { itemLinks: string[]; parentLinks: string[]; max?: number }): ApplyUrlCandidate[] {
  const out: ApplyUrlCandidate[] = [];
  const seen = new Set<string>();
  const add = (url: string, scope: ApplyUrlCandidate["scope"]): void => {
    if (!/^https:\/\//.test(url)) return;
    const c = canonUrl(url);
    if (c.cls === "invalid" || c.cls === "social") return;
    if (c.cls === "shortener" && scope !== "item") return;
    if (seen.has(c.key)) return;
    seen.add(c.key);
    out.push({ url, scope, cls: c.cls === "shortener" ? "shortener" : c.cls === "specific" ? "specific" : "generic" });
  };
  for (const u of a.itemLinks) add(u, "item");
  for (const u of a.parentLinks) add(u, "parent");
  return out.sort((x, y) => (x.cls === "specific" ? 0 : 1) - (y.cls === "specific" ? 0 : 1)).slice(0, a.max ?? 3);
}

/** ページ本文から、応募単位に関わる観察の手掛かりの行（店舗の選択・グループ・応募回数・制限・受取）を抜き出す。判断はAI。長さを制限して渡す */
export function excerptApplyPage(text: string, maxChars = 1800): string[] {
  const CUE = /店舗|選択|選べ|お選び|グループ|応募回数|1人|お一人|おひとり|重複|同時応募|無効|落選|受取|お渡し|配送|当選後|応募期間|応募方法|フォーム|商品/;
  const lines = text.normalize("NFKC").split(/\n+/).map((l) => l.trim()).filter((l) => l.length >= 4 && l.length <= 200 && CUE.test(l));
  const out: string[] = [];
  let n = 0;
  for (const l of [...new Set(lines)]) {
    if (n + l.length > maxChars) break;
    out.push(l);
    n += l.length;
  }
  return out;
}

/**
 * 取得したページが「この項目の抽選のページ」か（店舗の対応）。**親投稿に付いていたリンクは、親投稿の全項目に共通**で、別の店舗のページかもしれない。
 * ページの文面（タイトル・冒頭・手掛かりの行）に、項目の店舗名（または系列名）が現れなければ、この項目の根拠としては使わない（scope_mismatch）。
 * 判断ではなく、ページを誤った項目に結びつけないための妥当性の検査。店舗が不明な項目は、ページに系列名があるときだけ「系列レベル」で認める。
 */
export function pageMatchesItem(page: { lines: string[]; head: string }, item: { store: string | null; chain: string | null }): "store_match" | "chain_only" | "scope_mismatch" {
  const norm = (x: string): string => x.normalize("NFKC").toLowerCase().replace(/[ \t\r\n　（）()【】・\-]/g, "").replace(/店$/, "");
  const body = norm([page.head, ...page.lines].join("\n"));
  const st = norm(item.store ?? "");
  const ch = norm(item.chain ?? "");
  if (st.length >= 3 && body.includes(st)) return "store_match";
  if (ch.length >= 3 && body.includes(ch)) return st.length >= 3 ? "scope_mismatch" : "chain_only";
  return "scope_mismatch";
}
