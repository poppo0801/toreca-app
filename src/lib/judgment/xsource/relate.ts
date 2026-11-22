/**
 * 2つの情報源が、同じ抽選（応募機会）を指しているかの決定的な判定（Stage 10N・純関数）。
 * 結論は4種: same_opportunity（同じ応募機会）／same_campaign_different_opportunity（同じ企画だが応募が別。店舗別・別商品など）／independent（無関係）／unknown（根拠不足）。
 * 原則:
 *  - **URLの一致だけでは同一と決めない**（汎用のフォーム・系列共通のページ・短縮URLは根拠にならない）。同一には、系列・店舗・商品・期間・応募先の**複数の根拠**が要る。
 *  - **異なる系列・別店舗・別商品・別開催回を、安易に同一にしない**。矛盾する根拠（系列が違う・地域が違う・店舗が違う・商品が重ならない）があれば同一にしない。
 *  - 自分自身（同じ情報源・同じ候補から作られた登録）は、別の情報源として照合しない。
 *  - 同一でも項目に食い違いがあれば conflicts に残す（捨てず、後段で並べて保留）。
 */
import { chainsMatch, datesMatch, prefectureOf, productsMatch, storesMatch, urlsSupport } from "./normalize";
import type { Relation, SourceFact } from "./types";

/** 自分自身か（同じ情報源・同じ元の候補・候補から作られた登録とその候補） */
export function isSelf(a: SourceFact, b: SourceFact): boolean {
  if (a.sourceId === b.sourceId) return true;
  if (a.originId && a.originId === b.originId) return true;
  if (a.registration && b.originId && a.registration.id === b.originId) return true;
  if (b.registration && a.originId && b.registration.id === a.originId) return true;
  return false;
}

const storeCompat = (a: SourceFact, b: SourceFact): "same" | "select_member" | "partial" | "different" | "unknown" => {
  const direct = storesMatch(a.fields.store as string | null, b.fields.store as string | null);
  if (direct === "same") return "same";
  // 店舗選択式: 選択肢に相手の店舗が含まれる
  const inList = (list: string[] | undefined, s: unknown): boolean => !!list?.some((x) => storesMatch(x, s as string | null) === "same");
  if (inList(a.selectableStores, b.fields.store) || inList(b.selectableStores, a.fields.store)) return "select_member";
  return direct;
};

export function relateFacts(a: SourceFact, b: SourceFact): Relation {
  const evidence: string[] = [];
  const conflicts: string[] = [];
  if (isSelf(a, b)) return { kind: "unknown", score: 0, evidence: ["self"], conflicts };

  const chain = chainsMatch(a.fields.chain as string | null, b.fields.chain as string | null);
  const store = storeCompat(a, b);
  const prod = productsMatch(a.fields.products as string[] | null, b.fields.products as string[] | null);
  const dl = datesMatch(a.fields.applyDeadline as string | null, b.fields.applyDeadline as string | null);
  const st = datesMatch(a.fields.applyStart as string | null, b.fields.applyStart as string | null);
  const url = urlsSupport(a.urls, b.urls);
  const pa = prefectureOf(a.fields.prefecture as string | null, a.fields.store as string | null);
  const pb = prefectureOf(b.fields.prefecture as string | null, b.fields.store as string | null);

  // ---- 矛盾する根拠: 同一にしない
  if (chain === "different") return { kind: "independent", score: 0, evidence: ["chain_different"], conflicts };
  if (pa && pb && pa !== pb) return { kind: "independent", score: 0, evidence: ["prefecture_different"], conflicts };

  if (store === "different") {
    // 同じ系列・同じ商品・同じ期間で店舗だけが違う = 店舗別の抽選（同じ企画の別の応募機会）。それ以外は無関係
    if (chain === "same" && (prod === "same" || prod === "overlap") && (dl === "same" || dl === "near")) return { kind: "same_campaign_different_opportunity", score: 0.3, evidence: ["same_chain", "same_product", "same_period", "store_different"], conflicts };
    return { kind: "independent", score: 0, evidence: ["store_different"], conflicts };
  }
  const storeKnown = store === "same" || store === "select_member";
  if (prod === "disjoint") {
    // 同じ応募ページで複数商品を選ぶ形なら同一の応募。それ以外は別の応募
    if (url === "specific_same" && (storeKnown || store === "unknown")) return { kind: "same_opportunity", score: 0.65, evidence: ["same_application_url", "products_differ_same_form"], conflicts: dl === "different" ? ["applyDeadline"] : [] };
    if (chain === "same" && store === "same" && (dl === "same" || dl === "near")) return { kind: "same_campaign_different_opportunity", score: 0.3, evidence: ["same_store", "same_period", "product_disjoint"], conflicts };
    return { kind: "independent", score: 0, evidence: ["product_disjoint"], conflicts };
  }

  // ---- 同一の根拠を数える（URLは、具体的なページの一致だけを強い根拠にする）
  let score = 0;
  if (chain === "same") {
    score += 0.15;
    evidence.push("chain_same");
  }
  if (store === "same") {
    score += 0.25;
    evidence.push("store_same");
  } else if (store === "select_member") {
    score += 0.2;
    evidence.push("store_select_member");
  } else if (store === "partial") {
    score += 0.1;
    evidence.push("store_partial");
  }
  if (prod === "same") {
    score += 0.25;
    evidence.push("product_same");
  } else if (prod === "overlap") {
    score += 0.15;
    evidence.push("product_overlap");
  }
  if (dl === "same") {
    score += 0.2;
    evidence.push("deadline_same");
  } else if (dl === "near") {
    score += 0.1;
    evidence.push("deadline_near");
  }
  if (url === "specific_same") {
    score += 0.3;
    evidence.push("url_specific_same");
  } else if (url === "generic_same") {
    score += 0.03;
    evidence.push("url_generic_same_no_support");
  } else if (url === "different") score -= 0.05;
  if (st === "different") conflicts.push("applyStart");
  if (dl === "different") conflicts.push("applyDeadline");

  const prodOk = prod === "same" || prod === "overlap";
  const periodOk = dl === "same" || dl === "near";
  // 同一と言える組み合わせ: (a) 店舗が確定（同じ／選択肢）＋商品が対応＋期間が一致 (b) 具体的な応募先URLが一致＋商品が矛盾しない＋店舗が矛盾しない
  const byFacts = storeKnown && prodOk && periodOk;
  const byUrl = url === "specific_same"; // 商品が矛盾（disjoint）・店舗が別・系列が別のものは、ここまでに除外済み
  if (byFacts || byUrl) return { kind: "same_opportunity", score: Math.min(1, Math.max(0.6, score)), evidence, conflicts };
  if (dl === "different" && prodOk && storeKnown) {
    // 店舗・商品は同じで、期間が違う: 別の開催回、または告知の訂正の可能性。決めない
    evidence.push("deadline_differs_other_round_or_correction");
    return { kind: "unknown", score, evidence, conflicts };
  }
  if (store === "unknown" || prod === "unknown" || dl === "unknown") evidence.push("insufficient_fields");
  return { kind: "unknown", score, evidence, conflicts };
}
