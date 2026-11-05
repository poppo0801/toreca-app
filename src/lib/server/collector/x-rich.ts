import "server-only";
import { extractPageText } from "@/lib/ai/page-text";
import type { ExtractRequest } from "@/lib/ai/provider";
import { remainingPosts, type QuotedPost, type XPost } from "@/lib/collector/x-posts";
import { MAX_IMAGES } from "@/lib/server/lottery-extract-service";
import { splitTallImages } from "@/lib/server/image-split";
import { fetchRespectingRobots, type SafeFetchResult } from "@/lib/server/safe-fetch";
import { fetchXImage, type XClient } from "@/lib/server/collector/x-client";
import { fetchXPost, parseXStatusUrl } from "@/lib/server/x-source";
import type { Db } from "@/lib/server/lottery-service";

/**
 * X投稿の取得と統合（単件URL解析・複数URLの一括解析・iPhone共有・自動収集で共通）。
 *   本文 ＋ 添付画像（複数・縦長は分割）＋ リンク先の本文 を1つの解析入力にまとめる。
 * X公式APIが使えるとき（キー設定済み・利用者が有効化・月額予算内）だけAPIで取得する。使えない・失敗したときは公式の公開oEmbedで本文だけを取得し、
 * 画像とリンク先は解析できていないことを notices で明示する（本文だけなのに、画像まで解析したように扱わない）。
 */

export type ImageInput = NonNullable<ExtractRequest["images"]>[number];

export interface XRichOk {
  ok: true;
  text: string;
  author: string;
  postedOn: string;
  images: ImageInput[];
  via: "api" | "oembed";
  /** 画面に出す補足（取得できなかった情報の明示を含む） */
  notices: string[];
  /** 添付画像の数 / 解析に使えた数 */
  imagesFound: number;
  imagesUsed: number;
  linkedPage: boolean;
  /** none=画像なし / not_fetched=画像あり・未取得（本文のみ） / partial=一部のみ取得 / fetched=すべて取得 */
  imageStatus: "none" | "not_fetched" | "partial" | "fetched";
  /** APIで取得した投稿（再解析で再取得しないために保持する）。公開oEmbedのときは無い */
  post?: { id: string; text: string; images: string[]; links: string[]; createdAt: string; username?: string; quoted?: QuotedPost };
}
export type XRichResult = XRichOk | { ok: false; message: string };

export interface EnrichDeps {
  fetchPage?: (url: string) => Promise<SafeFetchResult>;
  fetchImage?: typeof fetchXImage;
}

/** 画像の扱いを3段階で区別する: 見つかった（投稿に添付されていた）／取得できた（ダウンロード成功）／AIへ渡した（縦長の分割後の枚数） */
export interface ImageStats {
  found: number;
  fetched: number;
  sent: number;
}

/**
 * 本文・画像URL・リンク・引用元の投稿から、解析に渡す本文（リンク先の案内・引用元を統合）と画像（縦長は分割）を作る。
 * 引用元の投稿（まとめアカウントが公式の投稿を引用して紹介する場合）の本文・画像・リンクも使う。
 */
export async function enrichXPost(
  post: { text: string; links: string[]; images: string[]; quoted?: { username: string; text: string; images: string[]; links: string[] } },
  deps: EnrichDeps,
): Promise<{ text: string; images: ImageInput[]; linkedPage: boolean; imagesUsed: number; linkUrl?: string; stats: ImageStats; quotedUsed: boolean }> {
  let text = post.text;
  let linkedPage = false;
  const q = post.quoted;
  if (q && q.text.trim()) text += `\n\n【引用元の投稿${q.username ? `（@${q.username}）` : ""}】\n${q.text}`;
  // リンク先（抽選案内）があれば、アクセスできる範囲で本文を統合する（1件まで。robots.txt・SSRF対策つき）。自分の投稿のリンクを優先し、なければ引用元のリンク
  const ext = [...post.links, ...(q?.links ?? [])].find((l) => !/^https:\/\/(x|twitter)\.com\//.test(l));
  if (ext) {
    const pg = await (deps.fetchPage ?? ((u: string) => fetchRespectingRobots(u)))(ext);
    if (pg.ok) {
      const t2 = extractPageText(pg.body, pg.finalUrl);
      if (t2.text.length >= 30) {
        text += `\n\n【リンク先の案内（${ext}）】\n${t2.text.slice(0, 6000)}`;
        linkedPage = true;
      }
    }
  }
  const urls = [...post.images, ...(q?.images ?? [])];
  const images: ImageInput[] = [];
  for (const u of urls.slice(0, MAX_IMAGES)) {
    const img = await (deps.fetchImage ?? fetchXImage)(u);
    if (img) images.push({ mediaType: img.mediaType, base64: img.base64 });
  }
  let used = images;
  if (images.length > 0) {
    const split = await splitTallImages(images);
    if (split.ok) used = split.images.slice(0, MAX_IMAGES);
  }
  return { text: text.slice(0, 20_000), images: used, linkedPage, imagesUsed: images.length, linkUrl: ext, stats: { found: urls.length, fetched: images.length, sent: used.length }, quotedUsed: !!(q && (q.text.trim() || q.images.length)) };
}

const jstMonthStart = (now: Date) => new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(now)}-01T00:00:00+09:00`).toISOString();
const jstMonthFirstDay = (now: Date) => `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(now)}-01`;

/** X API（有料）を使ってよいか: 利用者が有効にし、月額予算が残っていて、キーがある。今月の使用量は自動収集・手動取得の合計 */
export async function xApiAllowance(db: Db, householdId: string, client: XClient | null, now = new Date()): Promise<{ allowed: boolean; reason: string; remaining: number }> {
  if (!client) return { allowed: false, reason: "X APIのキーが未設定のため、本文のみを取得しました。添付画像とリンク先は解析できていません", remaining: 0 };
  const { data: s } = await db.from("collection_settings").select("x_enabled,x_monthly_budget_jpy").eq("household_id", householdId).maybeSingle();
  if (!s?.x_enabled) return { allowed: false, reason: "X APIの利用が無効のため、本文のみを取得しました。添付画像とリンク先は解析できていません", remaining: 0 };
  const [runs, manual] = await Promise.all([
    db.from("collection_runs").select("x_posts").eq("household_id", householdId).gte("started_at", jstMonthStart(now)),
    db.from("collection_daily_stats").select("x_posts_manual").eq("household_id", householdId).gte("day", jstMonthFirstDay(now)),
  ]);
  const used = (runs.data ?? []).reduce((a, r) => a + r.x_posts, 0) + (manual.data ?? []).reduce((a, r) => a + r.x_posts_manual, 0);
  const remaining = remainingPosts({ monthPosts: used, budgetJpy: s.x_monthly_budget_jpy });
  if (remaining < 1) return { allowed: false, reason: "X APIの月額予算に達している（または0円の）ため、本文のみを取得しました。添付画像とリンク先は解析できていません", remaining: 0 };
  return { allowed: true, reason: "", remaining };
}

export interface XRichOptions {
  db: Db;
  householdId: string;
  client: XClient | null;
  enrich?: EnrichDeps;
  oembed?: typeof fetchXPost;
  now?: Date;
}

/**
 * X投稿URLから、解析に使う情報をまとめて取得する関数を作る（runExtraction の fetchXRich に渡す）。
 * 単件・一括・iPhone共有・自動収集のX投稿が、すべてこの処理を通る。
 */
export function makeXRichFetcher(o: XRichOptions): (url: string) => Promise<XRichResult> {
  return async (url) => {
    const parsed = parseXStatusUrl(url);
    if (!parsed) return { ok: false, message: "Xの投稿URL（https://x.com/ユーザー名/status/数字）を入力してください" };
    const notices: string[] = [];
    const gate = await xApiAllowance(o.db, o.householdId, o.client, o.now);
    if (gate.allowed && o.client) {
      const r = await o.client.getPost(parsed.id, parsed.user);
      if (r.ok) {
        // 利用量の記録（日本時間の日別統計）。取得できた分だけ
        await o.db.rpc("bump_collection_stats", { p_household: o.householdId, p_day: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(o.now ?? new Date()), p_delta: { x_posts_manual: 1 } }).then(() => undefined, () => undefined);
        const p = r.post;
        const rich = await enrichXPost(p, o.enrich ?? {});
        const imageStatus = rich.stats.found === 0 ? "none" : rich.imagesUsed === 0 ? "not_fetched" : rich.imagesUsed < rich.stats.found ? "partial" : "fetched";
        if (imageStatus === "not_fetched") notices.push(`画像未取得: 添付画像${rich.stats.found}枚を取得できませんでした（本文のみで解析します）`);
        else if (imageStatus === "partial") notices.push(`添付画像${rich.stats.found}枚のうち${rich.imagesUsed}枚を取得できました`);
        if (rich.linkUrl && !rich.linkedPage) notices.push("リンク先の本文は取得できませんでした（本文と画像のみで解析します）");
        return { ok: true, text: rich.text, author: p.authorId, postedOn: p.createdAt.slice(0, 10), images: rich.images, via: "api", notices, imagesFound: rich.stats.found, imagesUsed: rich.imagesUsed, linkedPage: rich.linkedPage, imageStatus, post: { id: p.id, text: p.text, images: p.images, links: p.links, createdAt: p.createdAt, username: p.username ?? parsed.user, ...(p.quoted ? { quoted: p.quoted } : {}) } };
      }
      notices.push(`X APIで取得できませんでした（${r.message}）。本文のみを取得します`);
    } else notices.push(gate.reason);

    const x = await (o.oembed ?? fetchXPost)(url);
    if (!x.ok) return x;
    notices.push(...x.notice);
    // 公開oEmbedでは画像そのものは取得できない。投稿に画像があるかは、本文末尾の画像リンク（pic.x.com 等）で分かる範囲だけ判定する
    const hasPic = /pic\.(x|twitter)\.com\//i.test(x.text);
    notices.push(hasPic ? "画像未取得: この投稿には画像があります。応募期間・受取方法などが画像にある場合は読み取れていません（本文のみ）" : "添付画像とリンク先は解析できていません（本文のみ）");
    // 本文のみの取得でも、投稿内の外部リンク（応募ページなど）の本文は統合する
    const links = [...(x.text.split("【投稿内のリンク】")[1] ?? "").matchAll(/https:\/\/\S+/g)].map((m) => m[0]);
    const withLink = links.length > 0 ? await enrichXPost({ text: x.text, links, images: [] }, o.enrich ?? {}) : null;
    if (withLink && !withLink.linkedPage) notices.push("リンク先の本文は取得できませんでした");
    return { ok: true, text: withLink?.text ?? x.text, author: x.author, postedOn: x.postedOn, images: [], via: "oembed", notices, imagesFound: 0, imagesUsed: 0, linkedPage: Boolean(withLink?.linkedPage), imageStatus: hasPic ? "not_fetched" : "none" };
  };
}

export type { XPost };
