/**
 * 応募サービス（LivePocket 等）のページの主催者の確認（Stage 9H-3C・純関数）。
 * 主催者が自分で書いた説明本文は、主催者が調べている抽選の系列・店舗と同じと確認できたときだけ、一次情報として評価する。
 * 応募サービスのドメイン全体を一次情報扱いにしない（誰でも掲載できるため、別の主催者のページを誤って一次にしない）。
 * 確認できなければ未確認（二次情報のまま）。サービス側の受付表示（販売受付期間など）は、確認できても一次にしない（本文の層だけが対象）。
 */
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { normName } from "@/lib/norm";
import { hostOf, type ClassifyContext } from "./source-class";

export interface OrganizerCheck {
  status: "verified" | "unverified" | "not_applicable";
  /** 確認の根拠（または確認できない理由）。記録・表示用 */
  basis: string;
}

/** 主催者を示す欄。「主催者: ○○」「販売元：○○」など。ページ全体の見出しや本文中の店名の言及は、主催者の根拠にしない */
const ORGANIZER_LINE = /(?:主催者?|販売元|運営会社?|運営元|開催者|出品者)\s*[:：]\s*([^\n]{1,80})/g;

export function verifyOrganizer(o: { kind: string; url: string; text: string; links?: { url: string; text?: string }[]; target: { chain: string; store?: string }; classify: ClassifyContext }): OrganizerCheck {
  if (o.kind !== "platform") return { status: "not_applicable", basis: "応募サービス以外" };
  const chainKey = o.target.chain ? chainCanonicalKey(o.target.chain) : "";
  const lines = [...o.text.matchAll(ORGANIZER_LINE)].map((m) => m[1].trim());
  const otherOrganizer = lines.find((l) => !!l);
  for (const l of lines) {
    const k = chainCanonicalKey(l);
    const n = normName(l);
    const store = o.target.store ? normName(o.target.store) : "";
    if ((chainKey.length >= 3 && (k.includes(chainKey) || chainKey.includes(k)) && k.length >= 3) || (store.length >= 3 && n.includes(store))) return { status: "verified", basis: `主催者欄「${l.slice(0, 40)}」が対象の系列・店舗と一致` };
  }
  // 利用者が登録した公式サイト・公式アカウントとの結びつき（ページが公式サイトへリンクしている／公式アカウントを名乗っている）
  const hosts = new Set((o.links ?? []).map((l) => hostOf(l.url)).filter(Boolean));
  const official = o.classify.officialHosts.find((h) => hosts.has(h.toLowerCase()) || o.text.toLowerCase().includes(h.toLowerCase()));
  if (official) return { status: "verified", basis: `登録済みの公式サイト（${official}）への記載・リンクがある` };
  const acct = o.classify.officialAccounts.find((a) => a && new RegExp(`(?:@|x\\.com/|twitter\\.com/)${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").test(`${o.text}\n${(o.links ?? []).map((l) => l.url).join("\n")}`));
  if (acct) return { status: "verified", basis: `登録済みの公式アカウント（@${acct}）の記載がある` };
  return { status: "unverified", basis: otherOrganizer ? `主催者欄「${otherOrganizer.slice(0, 40)}」が対象の系列・店舗と一致しない／確認できない` : "主催者を確認できる記載がない（見出し・本文中の店名だけでは確認しない）" };
}
