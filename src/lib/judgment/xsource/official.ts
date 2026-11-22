/**
 * 公式発信者の識別（Stage 10O・純関数）。「ドメインが公式サイトか」と「SNSアカウントが系列・店舗公式か」を**別々に**、**根拠つきで**判定する。
 * 確定の根拠にしないもの: プロフィールの自己申告・名称の類似・ロゴ・認証バッジの有無・フォロワー数。**公式と裏付けられなければ unknown**（公式とみなさない）。
 * 確定（official）に使う根拠は、公開ページの**相互リンク**だけ:
 *   ・サイトのページが、そのアカウントのURLへリンクしている（サイト側がアカウントを公式と示している）
 *   ・かつ、アカウントの投稿・プロフィールが、そのドメインへリンクしている（アカウント側もサイトを示している）
 * 補助（likely=公式の可能性が高いが確定しない）: 同じ系列の複数の登録で繰り返し使われ、他の系列では使われていないホスト（履歴）。共有のサービス（フォーム・チケット・短縮・SNS）は対象外。
 * 取得日時を保持し、根拠が古くなったものは再確認を要する（maxAgeDays）。
 */
import { canonUrl } from "./normalize";

export type OfficialStatus = "official" | "likely" | "unknown";
export interface OfficialBasis {
  code: "reciprocal_link" | "site_links_account_only" | "account_links_site_only" | "history_exclusive_host" | "shared_platform" | "no_evidence" | "stale";
  checkedAt: string | null;
}
export interface OfficialVerdict {
  status: OfficialStatus;
  basis: OfficialBasis[];
}

/** 複数の事業者が共通で使うサービス（フォーム・チケット・予約・短縮・SNS・まとめサイト）。ここのホストは「その系列の公式サイト」の根拠にしない */
const SHARED_HOSTS = /(^|\.)(docs\.google\.com|forms\.gle|forms\.office\.com|livepocket\.jp|peatix\.com|eplus\.jp|pia\.jp|l-tike\.com|t\.co|bit\.ly|x\.com|twitter\.com|instagram\.com|facebook\.com|line\.me|lin\.ee|note\.com|ameblo\.jp|amazon\.co\.jp|rakuten\.co\.jp|yahoo\.co\.jp|dorasuta\.jp|pokemon-card\.com|lit\.link|linktr\.ee|youtube\.com)$/i;
export const isSharedHost = (host: string): boolean => SHARED_HOSTS.test(host.toLowerCase().replace(/^www\./, ""));

/** X のアカウント名の正規化（@・大文字小文字）。投稿URL・プロフィールURLからも取り出す */
export function handleOf(raw: string): string | null {
  const s = raw.trim();
  const m = /^@?([A-Za-z0-9_]{1,15})$/.exec(s) ?? /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(s);
  const h = m?.[1]?.toLowerCase() ?? null;
  return h && !["home", "i", "intent", "share", "search", "hashtag", "explore", "settings"].includes(h) ? h : null;
}

const linksTo = (links: string[], pred: (u: URL) => boolean): boolean =>
  links.some((l) => {
    try {
      return pred(new URL(l));
    } catch {
      return false;
    }
  });

export interface OfficialEvidence {
  host: string;
  /** サイト（そのホストの公開ページ）から出ているリンク（取得時のもの）と、取得日時 */
  siteLinks: string[] | null;
  siteCheckedAt: string | null;
  /** アカウント名（照合対象）と、その投稿・プロフィールに含まれるリンク（取得時のもの） */
  handle: string | null;
  accountLinks: string[] | null;
  accountCheckedAt: string | null;
}

/** 相互リンクによる公式判定（ドメインとアカウントの対）。片側だけのリンクは確定しない */
export function verifyOfficialPair(e: OfficialEvidence, now: Date, maxAgeDays = 90): OfficialVerdict {
  const host = e.host.toLowerCase().replace(/^www\./, "");
  if (isSharedHost(host)) return { status: "unknown", basis: [{ code: "shared_platform", checkedAt: null }] };
  const handle = e.handle ? handleOf(e.handle) : null;
  if (!handle) return { status: "unknown", basis: [{ code: "no_evidence", checkedAt: null }] };
  const siteToAccount = !!e.siteLinks && linksTo(e.siteLinks, (u) => /^(www\.)?(x|twitter)\.com$/i.test(u.hostname) && (handleOf(u.href) ?? "") === handle);
  const accountToSite = !!e.accountLinks && linksTo(e.accountLinks, (u) => u.hostname.toLowerCase().replace(/^www\./, "") === host || u.hostname.toLowerCase().endsWith(`.${host}`));
  const stale = (iso: string | null): boolean => !iso || now.getTime() - Date.parse(iso) > maxAgeDays * 86_400_000;
  if (siteToAccount && accountToSite) {
    if (stale(e.siteCheckedAt) || stale(e.accountCheckedAt)) return { status: "likely", basis: [{ code: "stale", checkedAt: e.siteCheckedAt }] };
    return { status: "official", basis: [{ code: "reciprocal_link", checkedAt: e.siteCheckedAt }] };
  }
  if (siteToAccount) return { status: "unknown", basis: [{ code: "site_links_account_only", checkedAt: e.siteCheckedAt }] };
  if (accountToSite) return { status: "unknown", basis: [{ code: "account_links_site_only", checkedAt: e.accountCheckedAt }] };
  return { status: "unknown", basis: [{ code: "no_evidence", checkedAt: null }] };
}

/** 履歴による補助判定: そのホストが、1つの系列の複数の登録で使われ、他の系列では使われていない（共有サービスを除く）。確定はしない（likely まで） */
export function hostHistoryVerdict(host: string, usage: Map<string, Map<string, number>>, chainKey: string): OfficialVerdict {
  const h = host.toLowerCase().replace(/^www\./, "");
  if (isSharedHost(h)) return { status: "unknown", basis: [{ code: "shared_platform", checkedAt: null }] };
  const by = usage.get(h);
  if (!by || !by.has(chainKey)) return { status: "unknown", basis: [{ code: "no_evidence", checkedAt: null }] };
  const others = [...by.keys()].filter((k) => k !== chainKey).length;
  return (by.get(chainKey) ?? 0) >= 2 && others === 0 ? { status: "likely", basis: [{ code: "history_exclusive_host", checkedAt: null }] } : { status: "unknown", basis: [{ code: "no_evidence", checkedAt: null }] };
}

/** ホストの使用履歴（登録の応募先URLから）: ホスト → 系列キー → 件数 */
export function buildHostUsage(rows: { chainKey: string; urls: string[] }[]): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const hosts = new Set(r.urls.map((u) => canonUrl(u)).filter((c) => c.cls !== "invalid").map((c) => c.host));
    for (const h of hosts) {
      const by = m.get(h) ?? new Map<string, number>();
      by.set(r.chainKey, (by.get(r.chainKey) ?? 0) + 1);
      m.set(h, by);
    }
  }
  return m;
}

/**
 * 公式の判定結果から、情報源の種類（信頼性の格）を決める。確定（official）だけが official_* になり、それ以外は公式として扱わない。
 * 応募ページ（フォーム）は、公式と確定したサイトからリンクされている／ホストが公式（確定・可能性が高い）の場合だけ apply_form（最上位）。偽のフォーム・転載の応募ページを最上位にしない。
 */
export function kindForSource(base: "site" | "x" | "form", v: OfficialVerdict | null, opts: { linkedFromOfficial?: boolean } = {}): "official_site" | "official_x" | "apply_form" | "unknown" {
  if (base === "form") return opts.linkedFromOfficial || v?.status === "official" || v?.status === "likely" ? "apply_form" : "unknown";
  if (v?.status === "official") return base === "site" ? "official_site" : "official_x";
  return "unknown";
}
