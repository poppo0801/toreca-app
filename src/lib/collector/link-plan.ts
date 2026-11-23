/**
 * X投稿のリンクの「発見」「選別」「取得」「保存」を分離する純関数（Phase 2 収集の網羅性）。
 *
 * 背景（実コードの確認結果）: 以前の複数URL改善（Stage 10M/10S/10W: linkMap・item-links・link-evidence）は
 *   「どの項目がどの短縮URL→展開URLを持つか」という**対応付け**の改善で、リンク先ページの**本文取得**は対象外だった。
 *   本文取得（`enrichXPost`）は外部リンクの**最初の1件だけ**を取得していたため、複数店舗・複数商品の投稿では2件目以降の本文が
 *   収集時の根拠に一切入らなかった（発見・対応付けはできているのに、取得で失われていた）。
 *
 * ここでは4つの段階を別々に扱う:
 *   1. 発見   discoverLinks   : 投稿・引用元・本文中のURLを**全件**列挙（出所・順序・展開元を保持。重複は同じ正規化キーに集約）
 *   2. 選別   planLinkFetches : 取得してよいものを決める（SSRF/短縮URL/X投稿/ログイン系・件数・ホスト別上限）。**選ばなかった理由も台帳に残す**
 *   3. 取得   （呼び出し側）  : 選ばれたURLだけ robots・サイズ・時間の制限つきで取得
 *   4. 保存   （呼び出し側）  : 取得できた全文・取得できなかった理由を台帳つきで保存（無言で捨てない）
 */
import { canonUrl } from "@/lib/judgment/xsource/normalize";

export type LinkOrigin = "post" | "quoted" | "text" | "link_map";

export interface DiscoveredLink {
  /** 展開後の（取得対象の）URL */
  url: string;
  /** 重複判定用の正規化キー */
  key: string;
  host: string;
  /** 見つかった順（投稿本文のリンク→引用元→本文中）。項目との対応付けは別（link-evidence / item-links） */
  order: number;
  /** 見つかった場所（複数あれば全て） */
  origins: LinkOrigin[];
  /** 展開元の短縮URL（分かるとき） */
  shortUrl?: string;
  cls: "specific" | "generic" | "shortener" | "social" | "invalid";
}

export type FetchDecision = "fetch" | "skip";
export type SkipReason =
  | "social_post" // X/Twitter の投稿URL（投稿自体は別に取得済み）
  | "shortener" // 展開されていない短縮URL（追跡しない。robots に反する・追跡の回避をしない）
  | "invalid" // URLとして不正・http/https 以外
  | "unsafe" // 認証情報つき・IP直指定・ローカル・非標準ポート等
  | "over_total_limit" // 全体の取得件数の上限
  | "over_host_limit" // 同じホストの取得件数の上限
  | "duplicate"; // 同じページ（正規化キーが同じ）

export interface PlannedLink extends DiscoveredLink {
  decision: FetchDecision;
  reason?: SkipReason;
}

export interface LinkPlanLimits {
  /** 1投稿あたりに取得するページ数の上限 */
  maxFetch: number;
  /** 同じホストから取得するページ数の上限（アクセス頻度・負荷の抑制） */
  maxPerHost: number;
}
/** 既定: 店別応募URLが数十件並ぶまとめ投稿でも欠けない広さ（深さ・容量・時間は取得側が別に制限する） */
export const DEFAULT_LINK_LIMITS: LinkPlanLimits = { maxFetch: 24, maxPerHost: 16 };

const TCO = /https:\/\/t\.co\/[A-Za-z0-9]+/g;

const isUnsafe = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return true;
    if (u.port && !["80", "443", ""].includes(u.port)) return true;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
    if (/^\[.*\]$/.test(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
    return false;
  } catch {
    return true;
  }
};

/**
 * 投稿のリンクを**全件**発見する。同じページ（正規化キーが同じ）は1件にまとめ、出所は全て残す。順序は発見順で、URLの並べ替えで結果が変わらない（対応付けは別の層）。
 * linkMap があれば、本文中の短縮URL→展開URLの対応も発見元に加える（展開できなかった短縮URLは cls=shortener として残る）。
 */
export function discoverLinks(post: {
  text?: string;
  links?: readonly string[];
  linkMap?: readonly { short: string; url: string }[];
  quoted?: { links?: readonly string[]; text?: string } | null;
}): DiscoveredLink[] {
  const found = new Map<string, DiscoveredLink>();
  let order = 0;
  const add = (url: string, origin: LinkOrigin, shortUrl?: string) => {
    const u = String(url).trim();
    if (!u) return;
    const c = canonUrl(u);
    const key = c.cls === "invalid" ? u : c.key;
    const cur = found.get(key);
    if (cur) {
      if (!cur.origins.includes(origin)) cur.origins.push(origin);
      if (shortUrl && !cur.shortUrl) cur.shortUrl = shortUrl;
      return;
    }
    found.set(key, { url: u, key, host: c.host, order: order++, origins: [origin], ...(shortUrl ? { shortUrl } : {}), cls: c.cls });
  };
  const expand = new Map((post.linkMap ?? []).map((m) => [m.short, m.url]));
  for (const l of post.links ?? []) add(l, "post");
  for (const l of post.quoted?.links ?? []) add(l, "quoted");
  for (const m of post.linkMap ?? []) add(m.url, "link_map", m.short);
  // 本文中の短縮URL: 展開結果があれば展開先として（既出なら出所だけ追加）、無ければ未展開の短縮URLとして残す（追跡しない）
  for (const s of new Set([...(post.text ?? "").matchAll(TCO)].map((m) => m[0]))) {
    const exp = expand.get(s);
    if (exp) add(exp, "text", s);
    else add(s, "text");
  }
  return [...found.values()].sort((a, b) => a.order - b.order);
}

/**
 * 取得するリンクを選ぶ。**全件を無条件にクロールしない**一方で、選ばなかったものは理由つきで必ず残す（無言で捨てない）。
 * 順序は発見順（先頭だけでなく全体から。ホスト別の上限で1つのホストに偏らない）。
 */
export function planLinkFetches(links: readonly DiscoveredLink[], limits: LinkPlanLimits = DEFAULT_LINK_LIMITS): PlannedLink[] {
  const perHost = new Map<string, number>();
  let fetched = 0;
  return links.map((l) => {
    const skip = (reason: SkipReason): PlannedLink => ({ ...l, decision: "skip", reason });
    if (l.cls === "invalid" || !/^https?:\/\//i.test(l.url)) return skip("invalid");
    if (l.cls === "social") return skip("social_post");
    if (l.cls === "shortener") return skip("shortener");
    if (isUnsafe(l.url)) return skip("unsafe");
    if (fetched >= limits.maxFetch) return skip("over_total_limit");
    const n = perHost.get(l.host) ?? 0;
    if (n >= limits.maxPerHost) return skip("over_host_limit");
    perHost.set(l.host, n + 1);
    fetched++;
    return { ...l, decision: "fetch" };
  });
}

export type LinkFetchStatus = "fetched" | "failed" | "blocked" | "login_required" | "too_short" | "skipped";
/** 台帳の1行: リンクごとに「何が起きたか」を残す（保存・UI・再調査・欠落検知の共通の根拠） */
export interface LinkLedgerEntry {
  url: string;
  key: string;
  host: string;
  order: number;
  origins: LinkOrigin[];
  shortUrl?: string;
  status: LinkFetchStatus;
  /** failed/blocked/skipped の理由（人が読める短い文字列または SkipReason） */
  reason?: string;
  /** 取得できた整形後本文の字数と、取得元が切れていたか（サイズ上限・保存上限） */
  chars?: number;
  truncated?: boolean;
  /** 取得日時（ISO） */
  at?: string;
}

/** ログインが必要なページの判定（本文が極端に短く、ログイン誘導だけのとき）。回避せず「未確認」と記録する */
export function looksLikeLoginWall(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length > 400) return false;
  return /(ログイン|サインイン|会員登録|sign in|log in|login)/i.test(t) && /(パスワード|password|メールアドレス|email|会員)/i.test(t);
}

export function ledgerFromPlan(plan: readonly PlannedLink[]): LinkLedgerEntry[] {
  return plan.map((p) => ({ url: p.url.slice(0, 500), key: p.key.slice(0, 300), host: p.host, order: p.order, origins: p.origins, ...(p.shortUrl ? { shortUrl: p.shortUrl } : {}), status: "skipped" as const, ...(p.reason ? { reason: p.reason } : {}) }));
}
