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

// ================================================================ Stage 10O: 段階的な解決（不明の原因別の改善）
import { judgeRegion } from "@/lib/collector/region";

export type RegionStage = "online" | "store_master" | "stated_prefecture" | "store_name" | "ai_assist_verified" | "none";
export type TcgStage = "text" | "product_master" | "ai_assist_verified" | "none";

export interface ConditionContext {
  /** 店舗マスターの都道府県の検索（系列名・店舗名）。見つからなければ null */
  storeMaster?: (chain: string | null, store: string | null) => { prefecture: string | null; address?: string | null } | null;
  /** 商品名が登録済みの商品マスター（このアプリが扱うTCGの商品）に対応するか */
  productMaster?: (name: string) => boolean;
}
/** AIの補助の結果（**検証済みのものだけ**を渡す。出典の抜粋が与えた文脈に実在し、値が抜粋から裏づけられたもの） */
export interface VerifiedAssist {
  prefecture?: string | null;
  tcg?: "pokemon" | "other" | null;
}
export interface ResolvedConditions extends ConditionResult {
  stages: { region: RegionStage; tcg: TcgStage };
  /** 判断できない場合の主な原因（1つだけ数える。重複計上しない）。region_unknown / region_conflict / tcg_unknown / tcg_mixed / product_filter_not_evaluated */
  primaryUnknown: string | null;
}

export function resolveConditions(
  o: OpportunityForConditions,
  cond: Pick<CollectionConditions, "prefectures" | "includeOnline" | "productMode">,
  excluded: readonly ExcludedChain[] = [],
  ctx: ConditionContext = {},
  assist: VerifiedAssist = {},
): ResolvedConditions {
  const reasons: string[] = [];
  const basis: Record<string, string> = {};
  let regionStage: RegionStage = "none";
  let tcgStage: TcgStage = "none";
  const unknowns: string[] = [];

  // 除外系列
  if (matchExcludedChain(excluded, { chainName: o.chain, texts: o.texts, textMode: "unresolved" })) {
    reasons.push("excluded_chain");
    basis.chain = "ineligible";
  } else basis.chain = "eligible";

  // TCGの種類: 本文・商品名 → 商品マスターへの対応 → 検証済みのAI補助。出典の無い推測は確定しない
  const tcg = judgeTcg([...(o.texts ?? []), ...o.products]);
  if (tcg.category === "other") {
    reasons.push("other_tcg");
    basis.tcg = "ineligible";
    tcgStage = "text";
  } else if (tcg.category === "mixed") {
    basis.tcg = "unknown";
    unknowns.push("tcg_mixed");
    reasons.push("tcg_mixed_needs_review");
  } else if (tcg.category === "pokemon") {
    basis.tcg = "eligible";
    tcgStage = "text";
  } else if (o.products.some((p) => ctx.productMaster?.(p))) {
    basis.tcg = "eligible";
    tcgStage = "product_master";
  } else if (assist.tcg === "pokemon") {
    basis.tcg = "eligible";
    tcgStage = "ai_assist_verified";
  } else if (assist.tcg === "other") {
    basis.tcg = "ineligible";
    reasons.push("other_tcg");
    tcgStage = "ai_assist_verified";
  } else {
    basis.tcg = "unknown";
    unknowns.push("tcg_unknown");
    reasons.push("tcg_unknown");
  }

  // 地域: 通販 → 店舗マスター → 告知の県名・店舗名の地名（judgeRegion の既存規則）→ 検証済みのAI補助
  const online = o.online ?? (o.chain ? chainNameChannel(o.chain) === "online" : false);
  const storeless = !storeKey(o.store) && /通販|オンライン|ネット/.test(`${o.store ?? ""}${o.chain ?? ""}`);
  if (online || storeless) {
    regionStage = "online";
    basis.region = cond.includeOnline ? "eligible" : "ineligible";
    if (!cond.includeOnline) reasons.push("online_excluded");
  } else {
    const master = ctx.storeMaster?.(o.chain, o.store) ?? null;
    const j = judgeRegion({ masterPrefecture: master?.prefecture ?? null, address: master?.address ?? null, storeName: o.store, statedPrefecture: o.prefecture });
    let pref = j.prefecture;
    if (pref) regionStage = j.basis === "master" || j.basis === "address" ? "store_master" : j.basis === "stated_prefecture" ? "stated_prefecture" : "store_name";
    if (!pref && j.basis === "conflict") {
      basis.region = "unknown";
      unknowns.push("region_conflict");
      reasons.push("region_conflict");
    } else {
      if (!pref && assist.prefecture) {
        pref = assist.prefecture;
        regionStage = "ai_assist_verified";
      }
      if (!pref) {
        basis.region = "unknown";
        unknowns.push("region_unknown");
        reasons.push("region_unknown");
      } else {
        const hit = cond.prefectures.includes(resolveTargetPrefecture(pref, cond.prefectures));
        basis.region = hit ? "eligible" : "ineligible";
        if (!hit) reasons.push("region_out_of_scope");
      }
    }
  }
  // 商品の絞り込み: 商品マスターでの評価が要る。**未評価を「対象」とは扱わない**
  basis.product = cond.productMode === "all" ? "eligible" : "not_evaluated";
  if (cond.productMode !== "all") {
    reasons.push("product_filter_not_evaluated");
    unknowns.push("product_filter_not_evaluated");
  }
  const vals = Object.values(basis);
  const verdict: ConditionVerdict = vals.includes("ineligible") ? "ineligible" : vals.includes("unknown") || vals.includes("not_evaluated") ? "unknown" : "eligible";
  return { verdict, reasons, basis, stages: { region: regionStage, tcg: tcgStage }, primaryUnknown: verdict === "unknown" ? (unknowns[0] ?? null) : null };
}
