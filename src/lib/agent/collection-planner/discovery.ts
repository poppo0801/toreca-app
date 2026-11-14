/**
 * 新しい情報源（監視候補）の評価（Stage 9D・純関数）。公式性・関連性・取得可能性を、**取得したページの根拠**で決める（AIの自己評価では決めない）。
 *   公式性  verified   : 系列の公式サイトと同じドメイン、または公式サイトのページから直接リンクされている
 *           candidate  : ページに系列名はあるが、公式の根拠がない（第三者・まとめ・口コミの可能性）
 *           unverified : 系列との結びつきを確認できない
 *   関連性  抽選・応募に関する語の出現（high=2種類以上／medium=1種類／low=なし）
 *   取得可能性  公開ページとして取得できた（robots・ログイン・取得制限に当たらない）
 * 自動で監視対象に追加してよいのは、公式性=verified・関連性=high・取得可能・https・X以外・未登録の場合だけ（開発環境のみ。本番の監視対象は変更しない）。
 */
import { chainCanonicalKey } from "@/lib/chain-normalize";
import type { PageData } from "@/lib/agent/collection-planner/types";

export interface SourceEvaluation {
  url: string;
  kind: "web" | "x";
  name: string;
  official: "verified" | "candidate" | "unverified";
  relevance: "high" | "medium" | "low";
  fetchable: boolean;
  /** 根拠（取得したページの事実。AIの意見を含めない） */
  evidence: string[];
  recommend: "auto_add" | "candidate" | "reject";
  reason: string;
}

const LOTTERY_WORDS: { key: string; re: RegExp }[] = [
  { key: "抽選", re: /抽選/ },
  { key: "応募", re: /応募|エントリー/ },
  { key: "予約", re: /予約受付|予約販売/ },
  { key: "当選", re: /当選/ },
];
const SOCIAL_HOST = /(^|\.)(x\.com|twitter\.com)$/i;
/** ログイン・会員専用と分かるURL（取得しない・監視候補にしない） */
const LOGIN_PATH = /\/(login|signin|sign-in|mypage|account|member|cart)(\/|$|\?)/i;

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const sameSite = (a: string, b: string): boolean => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));

export function xUsernameOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (!SOCIAL_HOST.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})(\/|$)/);
    if (!m || /^(i|home|search|intent|share|hashtag|explore|settings|messages)$/i.test(m[1])) return null;
    return m[1];
  } catch {
    return null;
  }
}

export function evaluateSource(o: {
  url: string;
  /** 取得したページ（取得できなかった・取得していないときは null） */
  page: PageData | null;
  fetchOk: boolean;
  chain: { name: string; officialUrl?: string } | null;
  /** このURLへのリンクを載せていたページ（取得済み）。公式サイトのページなら公式性の根拠になる */
  linkedFrom?: PageData | null;
  /** すでに監視している情報源のURL */
  monitoredUrls: string[];
}): SourceEvaluation {
  const evidence: string[] = [];
  const host = hostOf(o.url);
  const xUser = xUsernameOf(o.url);
  const kind: "web" | "x" = xUser ? "x" : "web";
  const name = (o.page?.title || (xUser ? `@${xUser}` : host)).slice(0, 80);
  const base = { url: o.url, kind, name } as const;
  const reject = (reason: string): SourceEvaluation => ({ ...base, official: "unverified", relevance: "low", fetchable: o.fetchOk, evidence, recommend: "reject", reason });

  if (!/^https:\/\//i.test(o.url)) return reject("https の公開URLではありません");
  if (LOGIN_PATH.test(o.url)) return reject("ログインが必要なページの可能性があるため対象にしません");
  if (o.monitoredUrls.some((m) => hostOf(m) === host && new URL(m).pathname === new URL(o.url).pathname)) return reject("すでに監視している情報源です");

  // 公式性
  let official: SourceEvaluation["official"] = "unverified";
  const officialHost = o.chain?.officialUrl ? hostOf(o.chain.officialUrl) : "";
  if (officialHost && sameSite(host, officialHost)) {
    official = "verified";
    evidence.push(`系列の公式サイト（${officialHost}）と同じドメインです`);
  } else if (o.linkedFrom && officialHost && sameSite(hostOf(o.linkedFrom.url), officialHost) && o.linkedFrom.links.some((l) => hostOf(l.url) === host && (xUser ? xUsernameOf(l.url) === xUser : true))) {
    official = "verified";
    evidence.push(`系列の公式サイト（${officialHost}）のページからリンクされています`);
  } else if (o.chain && o.page) {
    const key = chainCanonicalKey(o.chain.name);
    if (key && chainCanonicalKey(`${o.page.title} ${o.page.text.slice(0, 400)}`).includes(key)) {
      official = "candidate";
      evidence.push("ページに系列名の記載がありますが、公式サイトとの結びつきを確認できていません");
    }
  }

  // 関連性（抽選に関する語）
  const body = `${o.page?.title ?? ""}\n${o.page?.text ?? ""}`;
  const hits = LOTTERY_WORDS.filter((w) => w.re.test(body)).map((w) => w.key);
  const relevance: SourceEvaluation["relevance"] = hits.length >= 2 ? "high" : hits.length === 1 ? "medium" : "low";
  if (hits.length) evidence.push(`抽選に関する語: ${hits.join("・")}`);

  // Xは有料API・本番のみの収集のため、候補として保存するだけ（取得も自動追加もしない）
  if (kind === "x") {
    evidence.push("X（旧Twitter）のアカウントです。取得は本番のAPI設定でのみ行うため、候補として保存します");
    return { ...base, official, relevance: official === "verified" ? "medium" : "low", fetchable: false, evidence, recommend: official === "verified" ? "candidate" : "reject", reason: official === "verified" ? "公式サイトからリンクされた公式アカウントの候補（人の確認後に監視へ）" : "公式との結びつきを確認できないXアカウント" };
  }
  if (!o.fetchOk) return { ...base, official, relevance, fetchable: false, evidence, recommend: "reject", reason: "公開ページとして取得できませんでした（取得制限・ログイン・エラー。回避しません）" };
  evidence.push("公開ページとして取得できました");
  if (official === "verified" && relevance === "high") return { ...base, official, relevance, fetchable: true, evidence, recommend: "auto_add", reason: "公式性・関連性・取得可能性を確認できました" };
  if (official === "unverified" || relevance === "low") return { ...base, official, relevance, fetchable: true, evidence, recommend: "reject", reason: official === "unverified" ? "公式との結びつきを確認できません" : "抽選に関する記載が見つかりません" };
  return { ...base, official, relevance, fetchable: true, evidence, recommend: "candidate", reason: official === "candidate" ? "公式の根拠が不足しているため、人の確認後に監視へ" : "抽選に関する記載が限定的なため、人の確認後に監視へ" };
}
