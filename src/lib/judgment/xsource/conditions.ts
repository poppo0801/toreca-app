/**
 * 応募機会が、利用者の収集条件（対象地域・TCGの種類・除外系列・通販）に合うか（Stage 10N・純関数）。**登録・通知の前に適用する判定の検証用**（シャドーでは書き込まない）。
 * 既存の部品を再利用: 地域＝`resolveTargetPrefecture`・`prefectureFromStoreName`、TCG種別＝`judgeTcg`、除外系列＝`matchExcludedChain`、通販＝`chainNameChannel`。
 * 結論: eligible（登録・通知の対象）／ineligible（対象外。理由つき）／unknown（情報不足で決められない＝人の確認）。**抽出件数と登録対象件数は別に数える**。
 * 判定に使えない条件（商品の絞り込みなど、商品マスターが要るもの）は、評価せず basis に明示する（黙って通さない）。
 */
import { chainNameChannel } from "@/lib/chain-normalize";
import { judgeTcg } from "@/lib/collector/category";
import { matchExcludedChain, type ExcludedChain } from "@/lib/collector/chain-exclusion";
import { resolveTargetPrefecture, type CollectionConditions } from "@/lib/collector/conditions";
import { prefectureOf, storeKey } from "./normalize";

export type ConditionVerdict = "eligible" | "ineligible" | "unknown";
export interface OpportunityForConditions {
  chain: string | null;
  store: string | null;
  prefecture: string | null;
  products: string[];
  /** 題名・本文など（TCGの種類・系列の判定の手掛かり）。原文は保存・表示しない */
  texts?: string[];
  /** 通販・オンラインの応募か（分かっているとき） */
  online?: boolean | null;
}
export interface ConditionResult {
  verdict: ConditionVerdict;
  reasons: string[];
  /** 条件ごとの判定（region／tcg／chain／online／product）。eligible・ineligible・unknown・not_evaluated */
  basis: Record<string, string>;
}

export function evaluateOpportunityConditions(
  o: OpportunityForConditions,
  cond: Pick<CollectionConditions, "prefectures" | "includeOnline" | "productMode">,
  excluded: readonly ExcludedChain[] = [],
): ConditionResult {
  const reasons: string[] = [];
  const basis: Record<string, string> = {};
  // 除外系列
  const m = matchExcludedChain(excluded, { chainName: o.chain, texts: o.texts, textMode: "unresolved" });
  if (m) {
    reasons.push("excluded_chain");
    basis.chain = "ineligible";
  } else basis.chain = "eligible";
  // TCGの種類
  const tcg = judgeTcg([...(o.texts ?? []), ...o.products]);
  if (tcg.category === "other") {
    reasons.push("other_tcg");
    basis.tcg = "ineligible";
  } else if (tcg.category === "mixed") {
    reasons.push("tcg_mixed_needs_review");
    basis.tcg = "unknown";
  } else basis.tcg = tcg.category === "pokemon" ? "eligible" : "unknown";
  if (tcg.category === "unknown") reasons.push("tcg_unknown");
  // 地域・通販
  const online = o.online ?? (o.chain ? chainNameChannel(o.chain) === "online" : false);
  const storeless = !storeKey(o.store) && /通販|オンライン|ネット/.test(`${o.store ?? ""}${o.chain ?? ""}`);
  if (online || storeless) {
    basis.region = cond.includeOnline ? "eligible" : "ineligible";
    if (!cond.includeOnline) reasons.push("online_excluded");
  } else {
    const pref = prefectureOf(o.prefecture, o.store);
    if (!pref) {
      basis.region = "unknown";
      reasons.push("region_unknown");
    } else {
      const hit = cond.prefectures.includes(resolveTargetPrefecture(pref, cond.prefectures));
      basis.region = hit ? "eligible" : "ineligible";
      if (!hit) reasons.push("region_out_of_scope");
    }
  }
  // 商品の絞り込み（商品マスターが要る）は、ここでは評価しない
  basis.product = cond.productMode === "all" ? "eligible" : "not_evaluated";
  if (cond.productMode !== "all") reasons.push("product_filter_not_evaluated");

  const vals = Object.values(basis);
  const verdict: ConditionVerdict = vals.includes("ineligible") ? "ineligible" : vals.includes("unknown") || vals.includes("not_evaluated") ? "unknown" : "eligible";
  return { verdict, reasons, basis };
}
