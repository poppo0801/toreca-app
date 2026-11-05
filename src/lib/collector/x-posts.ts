/**
 * X公式API(v2)の応答の解析と、利用料金の管理（純粋関数）。
 * 料金は「取得した投稿1件ごと」の従量課金（2026年時点の公開情報では1投稿あたり約0.005米ドル。実際の料金・上限は X Developer Console で確認する）。
 * 見積もりは安全側（切り上げ）で、利用者が決めた月額予算を超えないよう、取得前に残り件数を計算する。
 */

/** 1投稿あたりの見積もり(円)。為替・料金改定の余裕を見て、約0.005米ドル(≒0.8円)より高めに置く */
export const X_COST_PER_POST_JPY = 1.2;

export interface XPost {
  id: string;
  text: string;
  createdAt: string;
  authorId: string;
  url: string;
  /** 添付画像のURL（全件）。動画・GIFは対象外 */
  images: string[];
  /** 投稿内の外部リンク（短縮URLは展開後） */
  links: string[];
  /** 引用・返信などの参照（投稿ID） */
  refs: { type: string; id: string }[];
  /** 投稿者のアカウント名（取得できたとき） */
  username?: string;
  /** 投稿者のプロフィール（表示名・所在地・自己紹介。店舗の特定に使う。取得できたときだけ） */
  profile?: XProfile;
  /** 引用している投稿（APIが展開して返したとき）。まとめアカウントは公式の投稿を引用して紹介することが多い */
  quoted?: QuotedPost;
}

/** X投稿者のプロフィール（公開情報）。公式の店舗アカウントは、表示名に系列・店舗名、所在地欄に住所が書かれていることが多い */
export interface XProfile {
  name: string;
  location: string;
  description: string;
}

export interface QuotedPost {
  id: string;
  username: string;
  profile?: XProfile;
  text: string;
  createdAt: string;
  images: string[];
  links: string[];
}

interface RawTweet {
  id?: unknown;
  text?: unknown;
  note_tweet?: { text?: unknown };
  created_at?: unknown;
  author_id?: unknown;
  entities?: { urls?: { expanded_url?: unknown; unwound_url?: unknown; display_url?: unknown }[] };
  attachments?: { media_keys?: unknown };
  referenced_tweets?: { type?: unknown; id?: unknown }[];
}
interface RawMedia {
  media_key?: unknown;
  type?: unknown;
  url?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** 投稿の一覧応答 → 投稿。不正な要素は捨てる。username は投稿URLの組み立てに使う */
export function parseXPosts(json: unknown, username: string): XPost[] {
  if (!json || typeof json !== "object") return [];
  const j = json as { data?: RawTweet[]; includes?: { media?: RawMedia[]; tweets?: RawTweet[]; users?: { id?: unknown; username?: unknown; name?: unknown; location?: unknown; description?: unknown }[] } };
  const media = new Map<string, RawMedia>();
  for (const m of j.includes?.media ?? []) if (typeof m.media_key === "string") media.set(m.media_key, m);
  const users = new Map<string, string>();
  const profiles = new Map<string, XProfile>();
  for (const u of j.includes?.users ?? []) {
    if (typeof u.id === "string" && typeof u.username === "string") users.set(u.id, u.username);
    if (typeof u.id === "string" && (typeof u.name === "string" || typeof u.location === "string")) profiles.set(u.id, { name: str(u.name).slice(0, 80), location: str(u.location).slice(0, 100), description: str(u.description).slice(0, 300) });
  }
  const included = new Map<string, RawTweet>();
  for (const it of j.includes?.tweets ?? []) if (typeof it.id === "string") included.set(it.id, it);

  const imagesOf = (t: RawTweet): string[] => {
    const keys = Array.isArray(t.attachments?.media_keys) ? (t.attachments!.media_keys as unknown[]).filter((k): k is string => typeof k === "string") : [];
    return keys.flatMap((k) => {
      const m = media.get(k);
      const url = str(m?.url);
      return m?.type === "photo" && /^https:\/\/pbs\.twimg\.com\//.test(url) ? [url] : [];
    });
  };
  const linksOf = (t: RawTweet): string[] => [
    ...new Set(
      (t.entities?.urls ?? [])
        .map((u) => str(u.unwound_url) || str(u.expanded_url))
        // 画像・投稿自身へのリンク(twitter.com/.../photo/1 など)は外部リンクではない
        .filter((u) => /^https:\/\//.test(u) && !/^https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+\/(photo|video)\//.test(u)),
    ),
  ];
  /** 長い投稿（280文字超）は note_tweet に全文がある。text は途中までのことがある */
  const fullText = (t: RawTweet) => str(t.note_tweet?.text) || str(t.text);

  const out: XPost[] = [];
  for (const t of j.data ?? []) {
    const id = str(t.id);
    if (!/^\d{1,25}$/.test(id)) continue;
    const q = (t.referenced_tweets ?? []).find((r) => r.type === "quoted");
    const qt = q && typeof q.id === "string" ? included.get(q.id) : undefined;
    const quoted: QuotedPost | undefined = qt
      ? { id: str(qt.id), username: users.get(str(qt.author_id)) ?? "", ...(profiles.has(str(qt.author_id)) ? { profile: profiles.get(str(qt.author_id)) } : {}), text: fullText(qt), createdAt: str(qt.created_at), images: imagesOf(qt), links: linksOf(qt) }
      : undefined;
    out.push({
      id,
      text: fullText(t),
      createdAt: str(t.created_at),
      authorId: str(t.author_id),
      url: `https://x.com/${username}/status/${id}`,
      username: users.get(str(t.author_id)) || username,
      ...(profiles.has(str(t.author_id)) ? { profile: profiles.get(str(t.author_id)) } : {}),
      images: imagesOf(t),
      links: linksOf(t),
      refs: (t.referenced_tweets ?? []).flatMap((r) => (typeof r.type === "string" && /^\d{1,25}$/.test(str(r.id)) ? [{ type: r.type, id: str(r.id) }] : [])),
      ...(quoted ? { quoted } : {}),
    });
  }
  return out;
}

/** 新しい順の投稿ID(数値文字列)の大小比較 */
export const compareId = (a: string, b: string) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);

export type XApiErrorCode = "not_configured" | "unauthorized" | "forbidden" | "credits_depleted" | "rate_limited" | "not_found" | "suspended" | "network" | "unknown";

export function classifyXError(status: number, body: unknown): { code: XApiErrorCode; message: string } {
  const detail = (() => {
    if (body && typeof body === "object") {
      const b = body as { title?: unknown; detail?: unknown; errors?: { message?: unknown; detail?: unknown }[] };
      return str(b.detail) || str(b.title) || str(b.errors?.[0]?.detail) || str(b.errors?.[0]?.message);
    }
    return "";
  })();
  const d = detail.slice(0, 140);
  if (status === 401) return { code: "unauthorized", message: "X APIの認証に失敗しました（Bearerトークンを確認してください）" };
  if (status === 402) return { code: "credits_depleted", message: "X APIの利用残高（クレジット）が不足しています。Developer Consoleでチャージするか、収集を停止してください" };
  if (status === 403) return { code: "forbidden", message: `X APIでこの操作が許可されていません${d ? `（${d}）` : ""}。プラン・権限を確認してください` };
  if (status === 404) return { code: "not_found", message: "アカウントが見つかりません" };
  if (status === 429) return { code: "rate_limited", message: "X APIのレート制限に達しました。時間をおいて再実行してください" };
  return { code: "unknown", message: `X APIがエラーを返しました（${status}）${d ? `: ${d}` : ""}` };
}

/** 今月あと何件まで取得してよいか。予算0円・未設定なら0 */
export function remainingPosts(opts: { monthPosts: number; budgetJpy: number; costPerPostJpy?: number }): number {
  const cost = opts.costPerPostJpy ?? X_COST_PER_POST_JPY;
  if (opts.budgetJpy <= 0 || cost <= 0) return 0;
  return Math.max(0, Math.floor(opts.budgetJpy / cost) - opts.monthPosts);
}

export const estimateCostJpy = (posts: number) => Math.ceil(posts * X_COST_PER_POST_JPY);
