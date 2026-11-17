/**
 * 抽選の一次情報リンク（情報元URL）の種類判別・優先順位・表示用の整形（Stage 9H-3L・純関数）。
 *
 * 方針:
 *  - 種類は、**ドメインやデータの事実**から判別できるものだけに付ける（LivePocket・X・登録済みの公式サイトのホスト・当落発表URL欄）。
 *    根拠のない推測（「公式」「公式アプリ」など）はしない。判別できないときは「外部サイト｜ドメイン名」。
 *  - X は、投稿者が公式アカウントかを示すデータが無いため「公式」とは付けない。
 *  - 新しいURLの収集はしない（既存の保存データだけを使う）。
 */
export type SourceLinkKind = "announcement" | "official_site" | "livepocket" | "x" | "other";

export interface SourceLink {
  url: string;
  kind: SourceLinkKind;
  /** 画面に出す文字（種類｜ドメイン） */
  label: string;
  domain: string;
  /** 小さいほど優先（1=当落発表ページ／2=公式の抽選情報ページ／3=LivePocket／4=その他） */
  priority: 1 | 2 | 3 | 4;
}

const URL_RE = /^https?:\/\//i;

export function hostOfUrl(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** URLの比較用の正規形（末尾のスラッシュ・フラグメントを除く）。同じページの重複表示を避ける */
export function urlKey(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}${x.search}`;
  } catch {
    return u.trim();
  }
}

const sameHost = (host: string, official: string) => host === official || host.endsWith(`.${official}`);

const KIND_LABEL: Record<SourceLinkKind, string> = { announcement: "当落発表", official_site: "公式サイト", livepocket: "LivePocket", x: "X", other: "外部サイト" };

export interface SourceLinkContext {
  /** 登録済みの公式サイトのホスト（店舗マスターの店舗URLなど。利用者が登録したもの） */
  officialHosts?: string[];
  /** 当落発表のURL（抽選の「結果確認URL」欄） */
  announcementUrl?: string | null;
}

/** 1つのURLを種類つきで整形する。http(s)以外・不正なURLは null */
export function describeSourceLink(url: string, ctx: SourceLinkContext = {}): SourceLink | null {
  const u = url.trim();
  if (!URL_RE.test(u)) return null;
  const domain = hostOfUrl(u);
  if (!domain) return null;
  const isAnnouncement = !!ctx.announcementUrl && urlKey(ctx.announcementUrl) === urlKey(u);
  const official = (ctx.officialHosts ?? []).map((h) => h.toLowerCase().replace(/^www\./, "")).filter(Boolean);
  let kind: SourceLinkKind;
  if (isAnnouncement) kind = "announcement";
  else if (sameHost(domain, "livepocket.jp")) kind = "livepocket";
  else if (domain === "x.com" || domain === "twitter.com" || domain === "mobile.twitter.com") kind = "x";
  else if (official.some((h) => sameHost(domain, h))) kind = "official_site";
  else kind = "other";
  const priority: SourceLink["priority"] = kind === "announcement" ? 1 : kind === "official_site" ? 2 : kind === "livepocket" ? 3 : 4;
  return { url: u, kind, label: `${KIND_LABEL[kind]}｜${domain}`, domain, priority };
}

/**
 * 表示するリンクを、優先順位（当落発表ページ → 公式の抽選情報ページ → LivePocket → その他）で並べる。
 * 同じURLは1つにまとめる（当落発表URLが情報元にも含まれるときは、当落発表として1つだけ）。同順位は保存順。
 */
export function pickSourceLinks(l: { announcementUrl?: string | null; sourceUrls?: string[] }, ctx: Omit<SourceLinkContext, "announcementUrl"> = {}, max = 3): SourceLink[] {
  const seen = new Set<string>();
  const out: SourceLink[] = [];
  const all = [...(l.announcementUrl ? [l.announcementUrl] : []), ...(l.sourceUrls ?? [])];
  for (const raw of all) {
    const d = describeSourceLink(raw, { ...ctx, announcementUrl: l.announcementUrl ?? null });
    if (!d) continue;
    const k = urlKey(d.url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out.map((x, i) => ({ x, i })).sort((a, b) => a.x.priority - b.x.priority || a.i - b.i).map((v) => v.x).slice(0, max);
}
