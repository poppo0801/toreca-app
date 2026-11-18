/**
 * 商品の根拠（出どころ）の記録と、情報源と商品の整合性の判定（Stage 9H-3J・純関数）。
 *
 * 原則: 「商品が実在する（商品マスターにある）」ことと「その抽選で販売される」ことは別の条件。
 * 商品には、根拠のURL・（分かれば）実際の最終遷移先・商品名が書かれた本文の抜粋・情報源の種類・信頼度を持たせる。
 *  - 根拠の原文が情報源の本文に見つからない → 確定候補にしない（保留。隔離対象）
 *  - 根拠が、まとめサイトの一覧の表示だけ（リンク先を取得できていない）→ 二次情報。リンク先で確認できるまで確定候補にしない（保留）
 * 取得できなかった事実を「商品が存在しない」と断定しない（取得失敗と、商品の記載が無いことを区別する）。
 */
import { splitProductDetail } from "./product-text";

export type ProvenanceKind = "page_body" | "list_display" | "x_post" | "unknown";
export type ProvenanceSupport =
  /** 商品名の根拠の原文を、情報源の本文で確認できた */
  | "found_in_source"
  /** まとめサイトの一覧の表示だけ（リンク先を取得できていない。取得失敗であって、商品が無いことの確認ではない） */
  | "list_only"
  /** 根拠の原文が、情報源の本文に見つからなかった */
  | "not_found_in_source"
  /** 根拠の原文が無い */
  | "no_quote";

export interface ItemProvenance {
  item: string;
  /** 根拠となった情報源のURL（短縮URLのときは元のURL） */
  sourceUrl: string;
  /** 実際の最終遷移先URL。取得できていないとき（取得制限・短縮URL）は null */
  finalUrl: string | null;
  kind: ProvenanceKind;
  tier: "primary" | "secondary";
  /** 商品名が書かれた本文の抜粋 */
  quote: string;
  support: ProvenanceSupport;
  confidence: "high" | "medium" | "low";
  note: string;
}

export type ProvenanceVerdict = "ok" | "unverified_secondary" | "unsupported";

export interface ProvenanceAssessment {
  records: ItemProvenance[];
  verdict: ProvenanceVerdict;
  /** 確定候補にしない理由（ok のときは空） */
  reasons: string[];
}

export interface ProvenanceInput {
  items: string[];
  /** 商品の根拠（AIの抜粋と、情報源の本文に実在したか） */
  evidence?: { quote?: string; verified?: boolean | null } | null;
  /** 取得が制限され、まとめサイトの一覧の表示（二次情報）から読み取った */
  viaList: boolean;
  sourceUrl: string;
  finalUrl?: string | null;
  /** 情報源の種類（X投稿・応募サービス・直接取得など） */
  sourceKind?: "x_post" | "web_page" | "list_site" | "unknown";
  /** 公式の情報源（登録済みの公式サイト・アカウント）か */
  official?: boolean;
}

export function assessItemProvenance(i: ProvenanceInput): ProvenanceAssessment {
  const quote = (i.evidence?.quote ?? "").trim();
  const kind: ProvenanceKind = i.viaList ? "list_display" : i.sourceKind === "x_post" ? "x_post" : i.sourceKind === "web_page" ? "page_body" : "unknown";
  const tier: ItemProvenance["tier"] = i.official && !i.viaList && kind === "page_body" ? "primary" : "secondary";
  const names = i.items.map((x) => splitProductDetail(x).name || x).filter(Boolean);
  const base = { sourceUrl: i.sourceUrl, finalUrl: i.finalUrl ?? null, kind, tier, quote: quote.slice(0, 160) };
  const records: ItemProvenance[] = names.map((item) => {
    if (!quote) return { ...base, item, support: "no_quote", confidence: "low", note: "商品名の根拠の原文がない（商品マスターにあるだけでは、この抽選の対象とは確定しない）" };
    if (i.evidence?.verified === false) return { ...base, item, support: "not_found_in_source", confidence: "low", note: "根拠の原文が、情報源の本文に見つからない（別ページの情報の混入・推測の疑い）" };
    if (i.viaList) return { ...base, item, support: "list_only", confidence: "low", note: "商品の根拠は、まとめサイトの一覧の表示のみ。リンク先のページは取得できておらず、商品の記載は未確認（取得失敗であり、商品が無いことの確認ではない）" };
    return { ...base, item, support: "found_in_source", confidence: tier === "primary" ? "high" : "medium", note: tier === "primary" ? "公式の情報源の本文で確認" : "情報源の本文で確認（二次情報）" };
  });
  const reasons: string[] = [];
  let verdict: ProvenanceVerdict = "ok";
  if (records.some((r) => r.support === "no_quote" || r.support === "not_found_in_source")) {
    verdict = "unsupported";
    reasons.push(...[...new Set(records.filter((r) => r.support === "no_quote" || r.support === "not_found_in_source").map((r) => `商品「${r.item}」: ${r.note}`))]);
  } else if (records.some((r) => r.support === "list_only")) {
    verdict = "unverified_secondary";
    reasons.push("商品の根拠が、まとめサイトの一覧の表示のみ（リンク先を取得できていない）。別の公式情報源で同じ抽選と確認できるまで、確定候補にしない");
  }
  return { records, verdict, reasons };
}
