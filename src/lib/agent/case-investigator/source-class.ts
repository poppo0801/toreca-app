/**
 * 情報源の分類（Stage 9H-1・純関数）。取得したページの根拠（URL・本文・リンク）から、情報源の種類・一次/二次・出どころ・層（主催者本文/サービス側表示）を決める。
 * 「公式だから正しい」「複数のサイトに書いてあるから正しい」とは判断しない。ここは分類と出どころの特定だけで、値の採否は台帳（ledger.ts）が決める。
 * 固定のサイト別巡回ルールではない: ホストの一覧は「チケット・応募サービス」のような種類の知識だけで、巡回順や取得手順は持たない。
 */
import { isOfficial, type SourceKind } from "@/lib/collector/fields";
import { PLATFORM_HOSTS } from "@/lib/collector/source-basis";

export { sourceBasis } from "@/lib/collector/source-basis";

/** 調査用の情報源の種類 */
export type CaseSourceKind =
  | "organizer_official" // 主催者（系列）の公式サイト・告知ページ
  | "store_official" // 店舗の公式ページ
  | "official_social" // 主催者・店舗の公式SNS（X）
  | "platform" // 応募・チケットサービス（LivePocket・Googleフォーム等）
  | "aggregator" // 抽選まとめサイト・まとめアカウント（二次情報）
  | "social_other" // その他のSNS投稿
  | "unknown";

export type Tier = "primary" | "secondary";
export const tierOfCase = (k: CaseSourceKind): Tier => (k === "organizer_official" || k === "store_official" || k === "official_social" ? "primary" : "secondary");

/** 応募・チケットサービス（主催者が告知本文を書き、サービスが受付期間などを表示する形式）。種類の知識であり、巡回規則ではない */
const SOCIAL_HOSTS = ["x.com", "twitter.com"];
export const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const hostIn = (h: string, list: string[]) => list.some((x) => h === x || h.endsWith(`.${x}`));

export interface ClassifyContext {
  /** 調査対象の系列の公式サイトのホスト（マスターの店舗URLなど、利用者が登録した情報） */
  officialHosts: string[];
  /** 調査対象の公式Xアカウント（小文字。利用者が登録した対応づけ） */
  officialAccounts: string[];
  /** 抽選まとめサイトのホスト・まとめアカウント */
  aggregatorHosts: string[];
  aggregatorAccounts: string[];
}
export const EMPTY_CLASSIFY_CTX: ClassifyContext = { officialHosts: [], officialAccounts: [], aggregatorHosts: [], aggregatorAccounts: [] };

export function classifyCaseSource(url: string, ctx: ClassifyContext): { kind: CaseSourceKind; tier: Tier; account?: string } {
  const host = hostOf(url);
  if (!host) return { kind: "unknown", tier: "secondary" };
  if (hostIn(host, SOCIAL_HOSTS)) {
    const acc = /^\/([A-Za-z0-9_]{1,15})(\/|$)/.exec(new URL(url).pathname)?.[1]?.toLowerCase();
    if (acc && ctx.officialAccounts.includes(acc)) return { kind: "official_social", tier: "primary", account: acc };
    if (acc && ctx.aggregatorAccounts.includes(acc)) return { kind: "aggregator", tier: "secondary", account: acc };
    return { kind: "social_other", tier: "secondary", ...(acc ? { account: acc } : {}) };
  }
  if (hostIn(host, ctx.aggregatorHosts)) return { kind: "aggregator", tier: "secondary", account: host };
  if (hostIn(host, ctx.officialHosts)) return { kind: "organizer_official", tier: "primary", account: host };
  if (hostIn(host, PLATFORM_HOSTS)) return { kind: "platform", tier: "secondary", account: host };
  return { kind: "unknown", tier: "secondary", account: host };
}

// ---------------------------------------------------------------- 層（主催者本文 / サービス側の表示）
const PLATFORM_META_LINE = /(販売受付期間|受付期間|チケット販売期間|販売期間|申込期間|販売開始日時|販売終了日時)\s*[:：]?/;

/**
 * 応募・チケットサービスのページ本文を、サービス側の受付メタデータと、主催者が書いた説明本文に分ける。
 * 「販売受付期間」などの行はサービス側の表示。説明本文に応募期間・当選発表の明記があれば、それが主催者の記載。
 * メタデータを抽選の応募期間と無条件に同一視しない。
 */
export function splitPlatformText(text: string): { organizerBody: string; platformMeta: string } {
  const body: string[] = [];
  const meta: string[] = [];
  for (const line of (text ?? "").split(/\n+/)) (PLATFORM_META_LINE.test(line) && line.length < 120 ? meta : body).push(line);
  return { organizerBody: body.join("\n").trim(), platformMeta: meta.join("\n").trim() };
}

/** 項目の値の出どころの層。platform のページ本文から読み取った値は、どの部分に根拠があるかで決める */
export function basisOfQuote(kind: CaseSourceKind, quote: string, pageText: string): "organizer_body" | "platform_meta" | undefined {
  if (kind !== "platform") return undefined;
  const { platformMeta } = splitPlatformText(pageText);
  const q = squash(quote);
  if (q && platformMeta && squash(platformMeta).includes(q)) return "platform_meta";
  return "organizer_body";
}


export const squash = (s: string): string => (s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

// ---------------------------------------------------------------- 出どころ（転載・引用の関係）
/**
 * 転載・引用元の特定。本文が「出典: URL」「引用元」「転載」などで別のURLを指すとき、その先が元の情報（出どころ）。
 * 出どころが同じ複数のページは、独立した裏付けとして数えない。見つからなければ、そのページ自身が出どころ。
 */
export function detectOrigin(selfUrl: string, text: string): { origin: string; derivedFrom: string | null } {
  const m = /(出典|引用元|転載元|ソース|source|via|参照元)\s*[:：]?\s*(https?:\/\/[^\s)）」』]+)/i.exec(text ?? "");
  if (m) {
    const ref = m[2].replace(/[#?].*$/, "").replace(/\/+$/, "");
    if (ref && hostOf(ref) && ref !== selfUrl.replace(/[#?].*$/, "").replace(/\/+$/, "")) return { origin: `u:${ref}`, derivedFrom: ref };
  }
  return { origin: `u:${selfUrl.replace(/[#?].*$/, "").replace(/\/+$/, "")}`, derivedFrom: null };
}

/** FieldSource 互換（既存の統合ロジックと同じ語彙）に変換 */
export function toFieldSourceKind(k: CaseSourceKind): SourceKind {
  switch (k) {
    case "organizer_official":
    case "store_official":
      return "official_site";
    case "official_social":
      return "official_x";
    case "aggregator":
      return "aggregator_x";
    default:
      return "unknown";
  }
}
export const isPrimarySource = (k: CaseSourceKind): boolean => isOfficial(toFieldSourceKind(k));
