// @vitest-environment node
import { describe, expect, it } from "vitest";
import { diffProposal, summarizeProposals, type SummaryInput } from "./proposal-summary";

describe("再評価の差分", () => {
  it("主要な項目（店舗・商品・締切・応募単位）の変化だけを示す。未確認⇄値も変化として示す。同じなら空", () => {
    const prev = { fields: { store: { value: "新宿本店" }, product: { value: "拡張パック" }, deadline: { value: null } }, apply_unit: "unknown" };
    const cur = { fields: { store: { value: "新宿本店（東館）" }, product: { value: "拡張パック" }, deadline: { value: "11/30" } }, apply_unit: "per_store" };
    expect(diffProposal(prev, cur)).toEqual([{ field: "store", before: "新宿本店", after: "新宿本店（東館）" }, { field: "deadline", before: "未確認", after: "11/30" }, { field: "apply_unit", before: "unknown", after: "per_store" }]);
    expect(diffProposal(prev, prev)).toEqual([]);
  });
});

describe("登録案の集計（定義を固定。閾値は作らない）", () => {
  const row = (c: string, mode: string, cost: number | null, review: SummaryInput["review"], outdated = false): SummaryInput => ({ candidate_id: c, mode, cost_jpy: cost, review, reviewOutdated: outdated });
  it("候補・登録案・モード別・費用・レビューの内訳・人の修正・解決率・修正率・未レビュー・再確認が必要なレビュー", () => {
    const s = summarizeProposals([
      row("a", "real", 0.3, { decision: "approve_with_edits", edits: { store: "x", product: "y" } }),
      row("a", "real", 0.2, { decision: "approve_with_edits", edits: {} }),
      row("b", "real", 0.1, { decision: "reject", edits: {} }, true),
      row("b", "mock", 0, { decision: "hold", edits: {} }),
      row("c", "mock", null, null),
    ]);
    expect(s).toMatchObject({ candidates: 3, proposals: 5, byMode: { real: 3, mock: 2 }, costJpy: 0.6, reviewed: 4, hold: 1, approveWithEdits: 2, reject: 1, withHumanEdits: 1, unreviewed: 1, outdatedReviews: 1, fieldEdits: { store: 1, product: 1 } });
    expect(s.resolutionRate).toBeCloseTo(3 / 5);
    expect(s.editRate).toBeCloseTo(1 / 2);
  });
  it("登録案が無いときの率は null（0%と混同しない）", () => {
    const s = summarizeProposals([]);
    expect(s).toMatchObject({ proposals: 0, candidates: 0, resolutionRate: null, editRate: null });
  });
});
