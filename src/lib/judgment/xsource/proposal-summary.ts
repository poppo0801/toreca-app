/**
 * 登録案の再評価の差分と、レビュー・費用・解決の集計（Phase 2・純関数）。
 *  - 差分: 人がレビューした版と、現行の版で、主要な項目（店舗・商品・締切・応募単位）がどう変わったか。**人のレビューは消えず、変更があれば再確認を促す**ための表示用。
 *  - 集計: 候補件数・登録案の件数・レビューの内訳・人の修正の率・項目ごとの修正数・費用・解決率。**指標の定義を固定**し、閾値は作らない（ベースラインの測定後に決める）。
 *      解決率 = （修正して承認＋却下）／登録案の件数。保留は未解決として数える。修正率 = 修正して承認のうち、少なくとも1項目を人が修正したもの／修正して承認。
 *    人の修正は「AIの値と人の値が食い違った」記録であり、**モデルが学習したことを意味しない**（保存した人の判断を、次回の入力に使うだけ）。
 */
export interface DiffField {
  value?: string | null;
  basis?: string;
}
export interface DiffSide {
  fields: Record<string, DiffField>;
  apply_unit: string;
}
export const DIFF_KEYS = ["store", "product", "deadline"] as const;

export function diffProposal(prev: DiffSide, cur: DiffSide): { field: string; before: string; after: string }[] {
  const out: { field: string; before: string; after: string }[] = [];
  const v = (x: DiffField | undefined): string => (x?.value && x.value.trim() ? x.value.trim() : "未確認");
  for (const k of DIFF_KEYS) if (v(prev.fields[k]) !== v(cur.fields[k])) out.push({ field: k, before: v(prev.fields[k]), after: v(cur.fields[k]) });
  if (prev.apply_unit !== cur.apply_unit) out.push({ field: "apply_unit", before: prev.apply_unit, after: cur.apply_unit });
  return out;
}

export interface SummaryInput {
  candidate_id: string;
  mode: string;
  cost_jpy: number | null;
  review: { decision: "hold" | "approve_with_edits" | "reject"; edits: Record<string, string> } | null;
  reviewOutdated: boolean;
}
export interface ProposalSummary {
  candidates: number;
  proposals: number;
  byMode: Record<string, number>;
  costJpy: number;
  reviewed: number;
  hold: number;
  approveWithEdits: number;
  reject: number;
  /** 修正して承認のうち、少なくとも1項目を人が修正したもの */
  withHumanEdits: number;
  /** 項目ごとの人の修正の件数（AIの値と人の値の食い違い） */
  fieldEdits: Record<string, number>;
  outdatedReviews: number;
  unreviewed: number;
  /** 解決率（0〜1）。proposals が 0 のとき null */
  resolutionRate: number | null;
  /** 修正率（0〜1）。修正して承認が 0 のとき null */
  editRate: number | null;
}

export function summarizeProposals(rows: SummaryInput[]): ProposalSummary {
  const s: ProposalSummary = { candidates: new Set(rows.map((r) => r.candidate_id)).size, proposals: rows.length, byMode: {}, costJpy: 0, reviewed: 0, hold: 0, approveWithEdits: 0, reject: 0, withHumanEdits: 0, fieldEdits: {}, outdatedReviews: 0, unreviewed: 0, resolutionRate: null, editRate: null };
  for (const r of rows) {
    s.byMode[r.mode] = (s.byMode[r.mode] ?? 0) + 1;
    s.costJpy += r.cost_jpy ?? 0;
    if (!r.review) {
      s.unreviewed++;
      continue;
    }
    s.reviewed++;
    if (r.reviewOutdated) s.outdatedReviews++;
    if (r.review.decision === "hold") s.hold++;
    else if (r.review.decision === "reject") s.reject++;
    else {
      s.approveWithEdits++;
      const keys = Object.keys(r.review.edits ?? {});
      if (keys.length) s.withHumanEdits++;
      for (const k of keys) s.fieldEdits[k] = (s.fieldEdits[k] ?? 0) + 1;
    }
  }
  s.costJpy = Math.round(s.costJpy * 10_000) / 10_000;
  s.resolutionRate = s.proposals ? (s.approveWithEdits + s.reject) / s.proposals : null;
  s.editRate = s.approveWithEdits ? s.withHumanEdits / s.approveWithEdits : null;
  return s;
}
