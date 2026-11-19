import type { SourceRecord } from "./ledger";

/**
 * 取得できなかった情報源に対する代替調査の記録と、再調査の促し（Stage 9H-3T・純関数）。
 *  - 取得できなかった（X・短縮URL・アクセス制限など）ときに、AIがそこで調査を終えないよう、検証（AIの外側）が具体的な状況を返す。
 *    検索語・調査先はAIが決める。固定の検索語・固定の順序は渡さない。アクセス制限の回避・認証の迂回は求めない
 *  - 結果には、取得できなかった情報源・代わりに取得できた情報源（層・種類・採用された項目）・確認できなかったことを保存する
 * 推測では確定しない: 代替で取得できても、二次情報は二次情報のまま（層は台帳が決める）。確認できなければ不明のまま。
 */
export interface AlternativeSummary {
  /** 取得できなかった情報源（理由つき） */
  blocked: { url: string; host: string; reason: string; failKind: string | null }[];
  /** 取得できなかったあとに、別のドメインで到達できた情報源（status: fetched=採用の対象／different_lottery=別の抽選／quarantined=同一抽選と確認できず／unreported=未報告） */
  found: { url: string; host: string; tier: string; kind: string; status: string; contributed: string[]; derivedFrom: string | null }[];
  /** 代替の情報源から、台帳の項目として採用された数（到達しただけでなく、同じ抽選の根拠として使えたもの） */
  recovered: number;
  /** 取得できなかった情報源があり、代替でも項目を確認できなかった */
  unresolved: boolean;
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
};

export function summarizeAlternatives(sources: SourceRecord[]): AlternativeSummary {
  const failed = sources.filter((s) => s.status === "failed");
  const blockedHosts = new Set(failed.map((s) => hostOf(s.url)));
  const found = sources.filter((s) => s.status !== "failed" && !!s.fetchedAt && !blockedHosts.has(hostOf(s.url)));
  const blocked = failed.map((s) => ({ url: s.url, host: hostOf(s.url), reason: (s.failReason ?? "取得できなかった").slice(0, 120), failKind: s.failKind ?? null }));
  const foundOut = found.map((s) => ({ url: s.url, host: hostOf(s.url), tier: s.tier, kind: s.kind, status: s.status, contributed: s.contributed.map(String), derivedFrom: s.derivedFrom }));
  const recovered = blocked.length ? foundOut.filter((f) => f.status === "fetched" && f.contributed.length > 0).length : 0;
  return { blocked, found: blocked.length ? foundOut : [], recovered, unresolved: blocked.length > 0 && recovered === 0 };
}

/**
 * 「これ以上調べられない」とAIが申告したとき、検証が一度だけ返す促し。取得できなかった事実と、まだ試していない種類の情報源を示す
 * （検索語は示さない）。返さない（null）のは、取得できなかった情報源が無い・検索の割り当てが残っていない・すでに促した場合。
 */
export function alternativeNudge(failed: SourceRecord[], searchesLeft: number, alreadyNudged: boolean): string | null {
  if (alreadyNudged || failed.length === 0 || searchesLeft <= 0) return null;
  const lines = failed.slice(0, 4).map((s) => `- ${s.url}（${(s.failReason ?? "取得できなかった").slice(0, 80)}）`);
  return [
    "検証: 次の情報源は取得できませんでした。取得できなかったことは「不明」の理由にはなりますが、調査をここで終える理由にはなりません。",
    ...lines,
    "アクセス制限の回避・ログイン・認証の迂回はしないでください。そのうえで、同じ告知が別の場所に公開されていないかを、検索で探してください",
    "（例の種類: 主催者・店舗の公式サイト／公式の店舗一覧・告知ページ／抽選受付サービス／同じ告知を引用・転載した記事。検索語と調べる順序はあなたが決めてください）。",
    "取得できたページは、一次か二次か（転載元は何か）を区別して report_page_findings で報告し、見つからなければ「確認できなかった」と終了してください。推測で項目を埋めないでください。",
  ].join("\n");
}
