/**
 * 公式サイトの検証（Stage 8D-3）。純粋なロジック。
 *
 * 「AIが公式だと言った」ことは根拠にしない。取得したページの内容から、検証できる根拠だけでドメインを分類する:
 *  - trusted  … 店舗マスターに登録済みの公式サイト（利用者が登録した store_url。同じ系列の他店舗のものを含む）
 *  - verified … 下記の根拠を満たした（店舗マスターには反映しない。調査結果に根拠つきで保存するだけ）
 *  - candidate… 根拠が不十分な公式候補（住所の「公式の裏付け」には使わない）
 *  - rejected … 第三者のサイト（SNS・まとめ・地図・ブログ・通販モール等）など、公式とみなさないもの
 * verified の条件（すべて）: ①ページのタイトルか見出しに系列名がある ②そのドメインの取得済みページに、店舗マスターの同じ系列の
 * 他店舗の名前が2つ以上（または他店舗1つと対象店舗）載っている（公式の店舗一覧との一致）③次のどちらか: 会社概要・運営会社・著作権表記が
 * 系列名の近くにある（運営元との一致）／信頼済みドメインのページからそのドメインへリンクが張られている（他の公式媒体からのリンク）。
 * 限界: 公式サイトの店舗一覧と会社情報をそっくり複製した悪意のあるサイトは、この条件だけでは見分けられない可能性がある
 * （その場合も、住所は地図の照合・複数情報源との一致・閉店の確認を通らなければ確認済みにならない）。
 */
import { distinctiveToken, domainOf, norm } from "@/lib/agent/store-location/common";
import type { PageEvidence, StoreTarget } from "@/lib/agent/store-location/verify";

export type OfficialStatus = "trusted" | "verified" | "candidate" | "rejected";
export const OFFICIAL_LABEL: Record<OfficialStatus, string> = { trusted: "公式（登録済み）", verified: "公式（検証済み）", candidate: "公式候補（根拠不十分）", rejected: "公式ではない（第三者）" };

export interface OfficialSiteAssessment {
  domain: string;
  status: OfficialStatus;
  /** 満たした根拠 */
  signals: string[];
  /** 足りない根拠・懸念 */
  problems: string[];
  urls: string[];
}

/** 公式とみなさないドメイン（SNS・まとめ・地図・口コミ・ブログ・通販モール・検索・百科事典など）。第三者サイトの上に「公式」を名乗っても公式にしない */
const THIRD_PARTY = [
  "x.com", "twitter.com", "instagram.com", "facebook.com", "youtube.com", "tiktok.com", "line.me", "threads.net",
  "note.com", "ameblo.jp", "hatenablog.com", "hatenablog.jp", "livedoor.jp", "fc2.com", "blogspot.com", "wordpress.com", "medium.com",
  "wikipedia.org", "google.com", "google.co.jp", "goo.ne.jp", "yahoo.co.jp", "bing.com", "tabelog.com", "retty.me", "navitime.co.jp", "mapion.co.jp", "ekiten.jp", "jalan.net",
  // 店舗・施設の一覧、電話帳、トレカ店のまとめ・地図・口コミなどの第三者の一覧サイト（転載元が同じ可能性があるため、公式にも、独立した根拠にもしない。店舗マスターに登録されていても公式扱いにしない）
  "pokemon-card.com", "machitoku.jp", "torecamap.co.jp", "hikakaku.com", "uridoki.net", "itp.ne.jp", "recyclemap.jp", "tokubai.co.jp", "shufoo.net", "homemate-research-shopping.com", "toreca-hack.com", "kj-weekly.jp", "nuimap.com", "charagoo.jp", "docomo.ne.jp", "tcg-map.com", "nansan.com",
  "amazon.co.jp", "rakuten.co.jp", "mercari.com", "yahoo.jp", "paypayfleamarket.yahoo.co.jp", "kakaku.com", "price.com", "togetter.com", "matome.naver.jp",
];

const OPERATOR = /(会社概要|運営会社|企業情報|会社情報|運営元|株式会社|有限会社|合同会社|©|copyright)/i;

export interface OfficialInput {
  store: StoreTarget;
  pages: PageEvidence[];
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};

export function assessOfficialSites({ store, pages }: OfficialInput): OfficialSiteAssessment[] {
  // 店舗マスターに登録された公式サイト。ただし、第三者の一覧サイト（地図・電話帳・まとめ等）が登録されていても、公式（trusted）にはしない
  const isThird = (d: string) => THIRD_PARTY.some((x) => d === x || d.endsWith(`.${x}`));
  const trusted = new Set(store.knownDomains.map((d) => domainOf(`https://${d}`)).filter((d) => !!d && !isThird(d)));
  const chainN = norm(store.chain);
  const chainKeys = [chainN, ...(store.chainAliases ?? []).map(norm), norm(store.name.split(/[\s　]+/)[0] ?? "")].filter((k) => k.length >= 2);
  const own = norm(distinctiveToken(store.chain, store.name));
  const siblings = store.siblingNames.map((n) => norm(distinctiveToken(store.chain, n))).filter((t) => t.length >= 2 && t !== own);

  const byDomain = new Map<string, PageEvidence[]>();
  for (const p of pages) {
    const d = domainOf(p.finalUrl ?? p.url);
    if (d) byDomain.set(d, [...(byDomain.get(d) ?? []), p]);
  }
  // 信頼済みドメインのページから張られたリンク先（他の公式媒体からのリンク）
  const linkedFromTrusted = new Set<string>();
  for (const p of pages) {
    if (!trusted.has(domainOf(p.finalUrl ?? p.url))) continue;
    for (const l of p.links ?? []) linkedFromTrusted.add(domainOf(l.href));
  }

  // 信頼済みの公式サイトのURLが、別のドメインへ転送された場合（例: 登録済みの旧ドメイン → 現在の公式ドメイン）。転送は公式サイト自身が行うもので、第三者には作れない
  const redirectedFromTrusted = new Set<string>();
  for (const p of pages) {
    const from = domainOf(p.url);
    const to = domainOf(p.finalUrl ?? p.url);
    if (from && to && from !== to && trusted.has(from) && !trusted.has(to)) redirectedFromTrusted.add(to);
  }

  const out: OfficialSiteAssessment[] = [];
  for (const [domain, ps] of byDomain) {
    const urls = ps.map((p) => p.finalUrl ?? p.url);
    if (trusted.has(domain)) {
      out.push({ domain, status: "trusted", signals: ["店舗マスターに登録済みの公式サイト"], problems: [], urls });
      continue;
    }
    if (redirectedFromTrusted.has(domain) && !THIRD_PARTY.some((x) => domain === x || domain.endsWith(`.${x}`))) {
      out.push({ domain, status: "verified", signals: ["登録済みの公式サイトから転送されている（公式サイト自身による転送）"], problems: [], urls });
      continue;
    }
    if (THIRD_PARTY.some((t) => domain === t || domain.endsWith(`.${t}`))) {
      out.push({ domain, status: "rejected", signals: [], problems: ["SNS・まとめ・地図・ブログ・通販モールなど第三者のサイト"], urls });
      continue;
    }
    const signals: string[] = [];
    const problems: string[] = [];
    const allText = ps.map((p) => norm(p.text)).join("\n");
    const nameInTitle = ps.some((p) => chainKeys.some((k) => norm(p.title ?? "").includes(k)) || chainKeys.some((k) => norm(p.text.split("\n")[0] ?? "").includes(k)));
    if (nameInTitle) signals.push("ページの見出しに系列名がある");
    else problems.push("ページの見出しに系列名がない");

    const sibHits = siblings.filter((t) => allText.includes(t)).length;
    const ownHit = !!own && allText.includes(own);
    const listMatch = sibHits >= 2 || (sibHits >= 1 && ownHit);
    if (listMatch) signals.push(`店舗マスターの同じ系列の他店舗${sibHits}件が一覧に載っている`);
    else problems.push("店舗マスターの同じ系列の店舗の一覧との一致が確認できない");

    const operatorNear = ps.some((p) => {
      const t = p.text.normalize("NFKC");
      for (const m of t.matchAll(new RegExp(OPERATOR.source, "gi"))) {
        const near = norm(t.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + 120));
        if (chainKeys.some((k) => near.includes(k))) return true;
      }
      return false;
    });
    // 系列名と運営会社の名前が違う場合（例: 「ふるいち」を運営する「株式会社テイツー」）: ページ末尾（フッター）に「会社概要」と法人名・著作権表記が揃う
    const operatorFooter = ps.some((p) => {
      const tail = p.text.normalize("NFKC").slice(-700);
      return /会社概要|企業情報|会社情報/.test(tail) && /(株式会社|有限会社|合同会社|(?:©|copyright)[^\n]{0,60}(?:co\.?,?\s*ltd|inc|corp|株式会社))/i.test(tail);
    });
    const operator = operatorNear || operatorFooter;
    if (operatorNear) signals.push("会社概要・運営会社・著作権表記が系列名の近くにある");
    else if (operatorFooter) signals.push("フッターに会社概要と運営法人の記載がある（法人名は系列名と別）");
    const linked = linkedFromTrusted.has(domain);
    if (linked) signals.push("信頼済みの公式サイトからリンクされている");
    if (!operator && !linked) problems.push("運営会社の情報も、信頼済みの公式サイトからのリンクも確認できない");

    const verified = nameInTitle && listMatch && (operator || linked);
    // 参考: どのドメインでも、ホスト名が店舗マスターの他の店舗と同じ系列の公式サイトに見えるだけでは不十分（名乗るだけでは公式にしない）
    out.push({ domain, status: verified ? "verified" : signals.length > 0 ? "candidate" : "candidate", signals, problems, urls });
  }
  return out.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.domain.localeCompare(b.domain));
}
const ORDER: Record<OfficialStatus, number> = { trusted: 0, verified: 1, candidate: 2, rejected: 3 };

/** そのURLが公式（trusted または verified）か */
export function isOfficialUrl(sites: OfficialSiteAssessment[], url: string): OfficialStatus | null {
  const d = domainOf(url);
  const s = sites.find((x) => x.domain === d);
  return s ? s.status : null;
}
export { hostOf };
