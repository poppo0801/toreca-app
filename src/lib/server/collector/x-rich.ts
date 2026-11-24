import "server-only";
import { extractPageText } from "@/lib/ai/page-text";
import { type HostGate, RunFetchBudget, type FetchOutcomeKind } from "@/lib/collector/fetch-control";
import { discoverLinks, ledgerFromPlan, looksLikeLoginWall, planLinkFetches, RECHECKABLE_REASONS, type LinkLedgerEntry, type LinkOrigin } from "@/lib/collector/link-plan";
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
  /** 取得できたリンク先の公開ページ本文（保存用。投稿本文とは別の出典として保存される） */
  linkedPages?: FetchedLinkPage[];
  /** 発見した全リンクの台帳（取得できた／できなかった／選ばなかった理由） */
  linkLedger?: LinkLedgerEntry[];
  /** none=画像なし / not_fetched=画像あり・未取得（本文のみ） / partial=一部のみ取得 / fetched=すべて取得 */
  imageStatus: "none" | "not_fetched" | "partial" | "fetched";
  /** APIで取得した投稿（再解析で再取得しないために保持する）。公開oEmbedのときは無い */
  post?: { id: string; text: string; images: string[]; links: string[]; createdAt: string; username?: string; quoted?: QuotedPost };
}
export type XRichResult = XRichOk | { ok: false; message: string };

/** 取得の負荷制御（Phase 2）。投稿・実行をまたいで共有する。未指定なら従来どおり制御しない（テスト・単件解析） */
export interface FetchControl {
  throttle?: HostGate;
  budget?: RunFetchBudget;
  shouldCancel?: () => boolean;
}

export interface EnrichDeps {
  fetchPage?: (url: string) => Promise<SafeFetchResult>;
  fetchImage?: typeof fetchXImage;
  control?: FetchControl;
}

/** 取得結果をホストの制御用の種類へ（404は「ページが無い」だけで、ホストの不調ではない） */
export function outcomeOf(r: SafeFetchResult): FetchOutcomeKind {
  if (r.ok) return "ok";
  if (r.code === "robots" || r.code === "blocked") return "blocked";
  if (r.code === "http_error") {
    if (r.status === 429 || r.status === 503) return "rate_limited";
    if (r.status === 401 || r.status === 403) return "blocked";
    if (r.status === 404 || r.status === 410) return "ok";
  }
  return "failure";
}

/** 画像の扱いを3段階で区別する: 見つかった（投稿に添付されていた）／取得できた（ダウンロード成功）／AIへ渡した（縦長の分割後の枚数） */
export interface ImageStats {
  found: number;
  fetched: number;
  sent: number;
}

/** 1ページの整形後本文として保持する上限（取得元の1.5MB上限と整合。通常の告知ページは数千〜数万字）。超えたら truncated を台帳に残す */
export const LINKED_PAGE_MAX_CHARS = 120_000;
/** 解析（AI）へ渡す統合テキスト全体の上限。超えたら**末尾を無言で切らず**、切ったことを本文に明記し、呼び出し側へ inputTruncated で知らせる（全文は別に保存済み） */
export const ANALYSIS_TEXT_MAX = 20_000;
/** 解析（AI）の入力に入れるリンク先本文の合計の目安。各リンクへ公平に配分し、先頭のリンクが後続を押し出さない（全文は別に保存される） */
export const ANALYSIS_LINK_BUDGET = 14_000;
/** 1投稿のリンク取得にかける時間の上限（超えたら残りは「時間切れ」として台帳に残す） */
export const LINK_FETCH_MAX_MS = 90_000;
/** 応募ページの先にある正式フォーム等（深さ1）を追う上限。応募に関係する案内のリンクだけ */
export const FOLLOW_MAX_PER_PAGE = 3;
export const FOLLOW_MAX_TOTAL = 6;
const FOLLOW_ANCHOR = /(応募|申込|申し込|エントリー|フォーム|抽選|受付|詳細はこちら|apply|entry|form)/i;

/** 取得できたリンク先ページ（全文）。保存・再解析の元。出所（どの投稿のどのリンクか）を保持する */
export interface FetchedLinkPage {
  url: string;
  finalUrl: string;
  title: string;
  /** 整形後の本文（LINKED_PAGE_MAX_CHARS まで。全文） */
  text: string;
  /** 取得元が上限で切れていたか（サイズ上限・文字数上限） */
  truncated: boolean;
  fetchedAt: string;
  /** 0=投稿のリンク／1=その先の案内（正式フォーム等） */
  depth: 0 | 1;
  fromUrl?: string;
  origins: LinkOrigin[];
  shortUrl?: string;
}

/** 合計予算を、各項目の必要量へ公平に配分する（少なくて済む項目は全量、残りを均等に。先頭の長いページが後続を押し出さない） */
export function allocateBudget(needs: readonly number[], total: number): number[] {
  const out = needs.map(() => 0);
  let left = total;
  let open = needs.map((_, i) => i);
  while (open.length > 0 && left > 0) {
    const share = Math.max(1, Math.floor(left / open.length));
    const small = open.filter((i) => needs[i] - out[i] <= share);
    if (small.length === 0) {
      for (const i of open) out[i] += share;
      break;
    }
    for (const i of small) {
      left -= needs[i] - out[i];
      out[i] = needs[i];
    }
    open = open.filter((i) => !small.includes(i));
  }
  return out;
}

/**
 * 本文・画像URL・リンク・引用元の投稿から、解析に渡す本文（リンク先の案内・引用元を統合）と画像（縦長は分割）を作る。
 * 引用元の投稿（まとめアカウントが公式の投稿を引用して紹介する場合）の本文・画像・リンクも使う。
 *
 * 台帳（linkLedger）に理由つきで残す。解析の入力には各ページを公平に配分して入れ、全文は linkedPages として呼び出し側が保存する。
 */
export async function enrichXPost(
  post: { text: string; links: string[]; images: string[]; linkMap?: { short: string; url: string }[]; quoted?: { username: string; text: string; images: string[]; links: string[] } },
  deps: EnrichDeps,
): Promise<{
  text: string;
  images: ImageInput[];
  linkedPage: boolean;
  /** 先頭の取得できたリンク先の本文（従来の呼び出し元との互換。全件は linkedPages） */
  linkedPageText?: string;
  imagesUsed: number;
  /** 先頭の取得対象URL（互換） */
  linkUrl?: string;
  stats: ImageStats;
  quotedUsed: boolean;
  /** 統合テキストが解析の入力の上限で切れたか（切れたときは本文に明記される）と、切る前の字数 */
  inputTruncated: boolean;
  inputChars: number;
  /** 取得できた全ページ（全文）。深さ1の追跡分を含む */
  linkedPages: FetchedLinkPage[];
  /** 発見した全リンクの台帳（取得できた／できなかった／選ばなかった理由） */
  linkLedger: LinkLedgerEntry[];
}> {
  let text = post.text;
  const q = post.quoted;
  if (q && q.text.trim()) text += `\n\n【引用元の投稿${q.username ? `（@${q.username}）` : ""}】\n${q.text}`;
  const fetchPage = deps.fetchPage ?? ((u: string) => fetchRespectingRobots(u));
  const started = Date.now();

  // 1) 発見 → 2) 選別（選ばなかった理由も台帳へ）
  const plan = planLinkFetches(discoverLinks({ text: post.text, links: post.links, ...(post.linkMap ? { linkMap: post.linkMap } : {}), quoted: q ?? null }));
  const ledger = new Map<string, LinkLedgerEntry>(ledgerFromPlan(plan).map((e) => [e.key, e]));
  const pages: FetchedLinkPage[] = [];
  const seen = new Set<string>();
  const pageLinks = new Map<FetchedLinkPage, { text: string; href: string }[]>();

  // 3) 取得（1ページずつ。時間の上限を超えたら残りは時間切れとして台帳に残す）
  const fetchOne = async (url: string, key: string, meta: { depth: 0 | 1; fromUrl?: string; origins: LinkOrigin[]; shortUrl?: string; order: number; host: string }): Promise<FetchedLinkPage | null> => {
    const entry: LinkLedgerEntry = ledger.get(key) ?? { url: url.slice(0, 500), key: key.slice(0, 300), host: meta.host, order: meta.order, origins: meta.origins, ...(meta.shortUrl ? { shortUrl: meta.shortUrl } : {}), status: "skipped" };
    ledger.set(key, entry);
    if (Date.now() - started > LINK_FETCH_MAX_MS) {
      entry.status = "skipped";
      entry.reason = "time_limit";
      return null;
    }
    const ctl = deps.control;
    const refuse = (cause: string) => {
      entry.status = "skipped";
      entry.reason = cause; // 取得しなかった理由は残す（上限・ホスト停止・締切・中止）。無言で捨てない
      return null;
    };
    if (ctl?.shouldCancel?.()) return refuse("cancelled");
    if (ctl?.budget) {
      const b = ctl.budget.tryStart("page");
      if (!b.ok) return refuse(b.cause);
    }
    const doFetch = () => fetchPage(url).catch((): SafeFetchResult => ({ ok: false, code: "network", message: "取得に失敗しました" }));
    let pg: SafeFetchResult;
    if (ctl?.throttle) {
      const t = await ctl.throttle.run(meta.host, async () => {
        const r = await doFetch();
        return { value: r, outcome: outcomeOf(r) };
      }, { deadlineAt: Math.min(started + LINK_FETCH_MAX_MS, ctl.budget?.limits.deadlineAt ?? Number.POSITIVE_INFINITY), ...(ctl.shouldCancel ? { shouldCancel: ctl.shouldCancel } : {}) });
      if (!t.ran) return refuse(t.cause);
      pg = t.value;
    } else pg = await doFetch();
    if (pg.ok) ctl?.budget?.addBytes(pg.body.length);
    entry.at = new Date().toISOString();
    if (!pg.ok) {
      entry.status = pg.code === "robots" || pg.code === "blocked" ? "blocked" : "failed";
      entry.reason = `${pg.code}`;
      return null;
    }
    const t2 = extractPageText(pg.body, pg.finalUrl, LINKED_PAGE_MAX_CHARS);
    if (looksLikeLoginWall(t2.text)) {
      entry.status = "login_required";
      entry.reason = "ログインが必要なページ（回避せず未確認として記録）";
      return null;
    }
    if (t2.text.length < 30) {
      entry.status = "too_short";
      entry.reason = "本文が短すぎる（JavaScript描画・画像のみ・空のページの可能性）";
      return null;
    }
    entry.status = "fetched";
    entry.chars = t2.text.length;
    entry.truncated = pg.truncated || t2.truncated;
    delete entry.reason;
    const page: FetchedLinkPage = { url: url.slice(0, 500), finalUrl: pg.finalUrl.slice(0, 500), title: t2.title.slice(0, 200), text: t2.text, truncated: pg.truncated || t2.truncated, fetchedAt: entry.at, depth: meta.depth, ...(meta.fromUrl ? { fromUrl: meta.fromUrl } : {}), origins: meta.origins, ...(meta.shortUrl ? { shortUrl: meta.shortUrl } : {}) };
    // 深さ1: 応募案内の先にある正式フォーム等の候補（案内的なリンク文言のものだけ。取得は呼び出し元の追跡ループで）
    pageLinks.set(page, t2.links);
    return page;
  };

  for (const p of plan) {
    if (p.decision !== "fetch") continue;
    seen.add(p.key);
    const pg = await fetchOne(p.url, p.key, { depth: 0, origins: p.origins, ...(p.shortUrl ? { shortUrl: p.shortUrl } : {}), order: p.order, host: p.host });
    if (pg) pages.push(pg);
  }
  // 深さ1の追跡（安全に・上限つき）。同じページ・X・短縮・不正は対象外
  let followed = 0;
  for (const base of [...pages]) {
    const cands = (pageLinks.get(base) ?? []).filter((l) => FOLLOW_ANCHOR.test(l.text));
    const sub = planLinkFetches(discoverLinks({ links: cands.map((c) => c.href) }), { maxFetch: FOLLOW_MAX_PER_PAGE, maxPerHost: FOLLOW_MAX_PER_PAGE }).filter((x) => x.decision === "fetch" && !seen.has(x.key));
    for (const s of sub) {
      if (followed >= FOLLOW_MAX_TOTAL) break;
      seen.add(s.key);
      followed++;
      const pg = await fetchOne(s.url, s.key, { depth: 1, fromUrl: base.url, origins: ["post"], order: 1000 + followed, host: s.host });
      if (pg) pages.push(pg);
    }
  }

  // 解析の入力へ: 各ページに公平に配分（先頭のリンクが後続を押し出さない）。省略したページは省略の事実と全文保存済みであることを明記
  const room = Math.max(3000, 20_000 - text.length - 1500);
  const budgets = allocateBudget(pages.map((p) => p.text.length), Math.min(ANALYSIS_LINK_BUDGET, room));
  pages.forEach((p, i) => {
    const cut = p.text.length > budgets[i];
    const body = cut ? `${p.text.slice(0, budgets[i])}\n（以下は省略。このページの全文は${p.text.length}字で保存済み・必要に応じて参照できます）` : p.text;
    text += `\n\n【リンク先の案内${pages.length > 1 ? `${i + 1}/${pages.length}` : ""}（${p.url}）】\n${body}`;
  });
  const ledgerList = [...ledger.values()].sort((a, b) => a.order - b.order);
  const omitted = ledgerList.filter((e) => e.status !== "fetched" && e.reason !== "social_post" && e.reason !== "duplicate");
  if (omitted.length > 0) text += `\n\n【取得できなかったリンク（${omitted.length}件）】\n${omitted.slice(0, 20).map((e) => `- ${e.url}（${e.status}${e.reason ? `: ${e.reason}` : ""}${e.reason && RECHECKABLE_REASONS.has(e.reason) ? "・未取得（上限・時間・制限のため。再調査で取得できる）" : ""}）`).join("\n")}`;

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
  const first = pages[0];
  const firstUrl = plan.find((p) => p.decision === "fetch")?.url;
  return {
    text: text.length > ANALYSIS_TEXT_MAX ? `${text.slice(0, ANALYSIS_TEXT_MAX - 80)}
（以下は解析の入力の上限（${ANALYSIS_TEXT_MAX}字）のため省略。全文は保存済み）` : text,
    inputTruncated: text.length > ANALYSIS_TEXT_MAX,
    inputChars: text.length,
    images: used,
    linkedPage: pages.length > 0,
    ...(first ? { linkedPageText: first.text.slice(0, 6000) } : {}),
    imagesUsed: images.length,
    ...(firstUrl ? { linkUrl: firstUrl } : {}),
    stats: { found: urls.length, fetched: images.length, sent: used.length },
    quotedUsed: !!(q && (q.text.trim() || q.images.length)),
    linkedPages: pages,
    linkLedger: ledgerList,
  };
}

const jstMonthStart = (now: Date) => new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(now)}-01T00:00:00+09:00`).toISOString();
const jstMonthFirstDay = (now: Date) => `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(now)}-01`;

/** 今月のX API(有料)の利用可否と残り件数。有効・予算・今月の使用量(自動収集・手動取得・ブックマーク同期の合計)から求める */
export async function xBudgetLeft(db: Db, householdId: string, now = new Date()): Promise<{ enabled: boolean; remaining: number; maxPostsPerRun: number }> {
  const { data: s } = await db.from("collection_settings").select("x_enabled,x_monthly_budget_jpy,x_max_posts_per_run").eq("household_id", householdId).maybeSingle();
  if (!s?.x_enabled) return { enabled: false, remaining: 0, maxPostsPerRun: 0 };
  const [runs, manual] = await Promise.all([
    db.from("collection_runs").select("x_posts").eq("household_id", householdId).gte("started_at", jstMonthStart(now)),
    db.from("collection_daily_stats").select("x_posts_manual").eq("household_id", householdId).gte("day", jstMonthFirstDay(now)),
  ]);
  const used = (runs.data ?? []).reduce((a, r) => a + r.x_posts, 0) + (manual.data ?? []).reduce((a, r) => a + r.x_posts_manual, 0);
  return { enabled: true, remaining: remainingPosts({ monthPosts: used, budgetJpy: s.x_monthly_budget_jpy }), maxPostsPerRun: s.x_max_posts_per_run };
}

/** X API（有料）を使ってよいか: 利用者が有効にし、月額予算が残っていて、キーがある。今月の使用量は自動収集・手動取得の合計 */
export async function xApiAllowance(db: Db, householdId: string, client: XClient | null, now = new Date()): Promise<{ allowed: boolean; reason: string; remaining: number }> {
  if (!client) return { allowed: false, reason: "X APIのキーが未設定のため、本文のみを取得しました。添付画像とリンク先は解析できていません", remaining: 0 };
  const b = await xBudgetLeft(db, householdId, now);
  if (!b.enabled) return { allowed: false, reason: "X APIの利用が無効のため、本文のみを取得しました。添付画像とリンク先は解析できていません", remaining: 0 };
  const remaining = b.remaining;
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
        if (rich.linkLedger.some((e) => e.status !== "fetched" && e.reason !== "social_post") && !rich.linkedPage) notices.push("リンク先の本文は取得できませんでした（本文と画像のみで解析します）");
        else if (rich.linkLedger.some((e) => e.status !== "fetched" && e.reason !== "social_post")) notices.push(`リンク${rich.linkLedger.length}件のうち${rich.linkedPages.length}件の本文を取得しました（取得できなかったリンクは台帳に記録${rich.linkLedger.some((e) => e.reason && RECHECKABLE_REASONS.has(e.reason)) ? `。うち${rich.linkLedger.filter((e) => e.reason && RECHECKABLE_REASONS.has(e.reason)).length}件は上限・時間・制限のため未取得で、再解析で取得できます` : ""}）`);
        return { ok: true, text: rich.text, author: p.authorId, postedOn: p.createdAt.slice(0, 10), images: rich.images, via: "api", notices, imagesFound: rich.stats.found, imagesUsed: rich.imagesUsed, linkedPage: rich.linkedPage, ...(rich.linkedPages.length ? { linkedPages: rich.linkedPages } : {}), linkLedger: rich.linkLedger, imageStatus, post: { id: p.id, text: p.text, images: p.images, links: p.links, createdAt: p.createdAt, username: p.username ?? parsed.user, ...(p.profile ? { profile: p.profile } : {}), ...(p.quoted ? { quoted: p.quoted } : {}) } };
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
    return { ok: true, text: withLink?.text ?? x.text, author: x.author, postedOn: x.postedOn, images: [], via: "oembed", notices, imagesFound: 0, imagesUsed: 0, linkedPage: Boolean(withLink?.linkedPage), ...(withLink?.linkedPages.length ? { linkedPages: withLink.linkedPages } : {}), ...(withLink ? { linkLedger: withLink.linkLedger } : {}), imageStatus: hasPic ? "not_fetched" : "none" };
  };
}

export type { XPost };
