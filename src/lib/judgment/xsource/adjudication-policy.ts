/**
 * AIのペア照合の揺れへの対処（Stage 10O・純関数）。AIの照合は実行ごとに結果が割れうる（10N実測: 同一 4件→2件）。
 *  - 同じペアを複数回（既定2回）照合し、**全回が同じ結論**で、かつ**決定的な独立根拠**（系列一致・締切一致・商品が矛盾しない・店舗が矛盾しない）を満たす場合だけ「統合の候補」。
 *  - 割れた・不明が混ざった場合は保留し、監査記録（各回の結論）を残す。**多数決で自動統合しない**。
 *  - 決定的な判定が「無関係・別応募」のペアは、AIがどう言っても覆さない。
 * 「統合の候補」も、決定的な機械検査を満たしているだけで、人の確認までは確定扱いにしない（確認画面で確認する）。
 */
import type { Relation, RelationKind } from "./types";

export type PolicyOutcome = "merge_candidate" | "hold_unstable" | "hold_insufficient_evidence" | "not_same_ai" | "deterministic_overrides";

/** 統合に必要な独立根拠の機械検査（relateFacts の根拠コードから） */
export function independentEvidenceOk(r: Relation): boolean {
  const e = new Set(r.evidence);
  if (e.has("store_different") || e.has("product_disjoint") || e.has("chain_different") || e.has("prefecture_different")) return false;
  const chain = e.has("chain_same");
  const deadline = e.has("deadline_same") || e.has("deadline_near");
  const product = e.has("product_same") || e.has("product_overlap");
  const store = e.has("store_same") || e.has("store_select_member") || e.has("store_partial");
  return chain && deadline && product && store && r.conflicts.length === 0;
}

export function applyAdjudicationPolicy(det: Relation, runs: RelationKind[], minRuns = 2): { outcome: PolicyOutcome; stable: boolean; runs: RelationKind[] } {
  if (det.kind === "independent" || det.kind === "same_campaign_different_opportunity") return { outcome: "deterministic_overrides", stable: true, runs };
  if (runs.length < minRuns) return { outcome: "hold_insufficient_evidence", stable: false, runs };
  const first = runs[0];
  const stable = runs.every((r) => r === first);
  if (!stable) return { outcome: "hold_unstable", stable, runs };
  if (first === "independent" || first === "same_campaign_different_opportunity") return { outcome: "not_same_ai", stable, runs };
  if (first === "same_opportunity") return { outcome: independentEvidenceOk(det) ? "merge_candidate" : "hold_insufficient_evidence", stable, runs };
  return { outcome: "hold_insufficient_evidence", stable, runs };
}
