/**
 * 人間評価（評価ツールの書き出し）の分類（Stage 9H-3J・純関数）。
 * 評価を、正しい／誤り／未確定（修正は入力されているが評価が選ばれていない・判断できない）に分け、隔離案件は別に示す。
 * **未確定の評価は、正解データ（学習）として使わない**。修正欄の意味（商品欄に書かれた抽選形態の指摘・「対象商品ではない」）も検証して返す。
 */
import { interpretCorrection, type CorrectionMeaning } from "./form-learning";

export interface FeedbackResult {
  caseId: string;
  human?: { verdict?: string | null; usableAsGold?: boolean; corrections?: { field: string; correctValue?: string }[]; comment?: string; validationIssues?: string[] };
}
export type FeedbackBucket = "correct" | "wrong" | "unconfirmed";

export interface FeedbackItem {
  caseId: string;
  bucket: FeedbackBucket;
  quarantined: boolean;
  /** 学習に使ってよいか（人間が確定した評価だけ） */
  learnable: boolean;
  /** 未確定の評価に入力された修正（参考。正解データにしない） */
  pendingCorrections: number;
  /** 修正欄の意味の検証で、欄と値が合わなかったもの */
  misplaced: CorrectionMeaning[];
}

export function classifyFeedback(results: FeedbackResult[], opts: { toCaseId: (resultCaseId: string) => string; quarantined: Set<string> }): { items: FeedbackItem[]; counts: Record<FeedbackBucket | "quarantined" | "learnable", number> } {
  const items: FeedbackItem[] = results.map((r) => {
    const h = r.human;
    const v = h?.verdict ?? null;
    const gold = h?.usableAsGold === true;
    const bucket: FeedbackBucket = gold && v === "correct" ? "correct" : gold && (v === "wrong" || v === "partial") ? "wrong" : "unconfirmed";
    const caseId = opts.toCaseId(r.caseId);
    const misplaced = (h?.corrections ?? []).map((c) => interpretCorrection(c.field, c.correctValue ?? "")).filter((m) => m.kind !== "field");
    return { caseId, bucket, quarantined: opts.quarantined.has(caseId), learnable: bucket !== "unconfirmed", pendingCorrections: bucket === "unconfirmed" ? (h?.corrections ?? []).length : 0, misplaced };
  });
  const c = (b: FeedbackBucket) => items.filter((x) => x.bucket === b).length;
  return { items, counts: { correct: c("correct"), wrong: c("wrong"), unconfirmed: c("unconfirmed"), quarantined: items.filter((x) => x.quarantined).length, learnable: items.filter((x) => x.learnable).length } };
}
