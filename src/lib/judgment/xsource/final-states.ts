/**
 * 実AI評価の事例ごとの最終状態の集計（Stage 10X）。**1事例＝1行（最終状態）**。限定的な再評価（判断の2回目）があっても、集計に二重計上しない。
 * 重複する事例IDがあれば集計せずに報告する（重複のない最終状態でだけ数える）。
 */
export type FinalCategory = "verified" | "judge_failed" | "held_quote" | "held_scope" | "held_budget" | "held_other" | "no_judgment";

export interface FinalStateInput {
  id: string;
  decision: string;
  verified: boolean;
  held: string[] | null;
}

export function finalCategory(r: FinalStateInput): FinalCategory {
  if (r.verified) return "verified";
  const h = r.held ?? [];
  if (h.includes("judge_failed")) return "judge_failed";
  if (h.some((x) => x.startsWith("budget_"))) return "held_budget";
  if (h.some((x) => x.startsWith("quote_not_found") || x.startsWith("evidence_missing"))) return "held_quote";
  if (h.some((x) => x.startsWith("scope_mismatch") || x.startsWith("shared_link_scope_unverified"))) return "held_scope";
  if (h.length) return "held_other";
  return r.decision === "none" ? "no_judgment" : "held_other";
}

export function summarizeFinal(rows: FinalStateInput[]): { total: number; duplicates: string[]; byCategory: Record<FinalCategory, number>; ids: Record<string, FinalCategory> } {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const byCategory: Record<FinalCategory, number> = { verified: 0, judge_failed: 0, held_quote: 0, held_scope: 0, held_budget: 0, held_other: 0, no_judgment: 0 };
  const ids: Record<string, FinalCategory> = {};
  for (const r of rows) {
    if (seen.has(r.id)) {
      duplicates.push(r.id);
      continue;
    }
    seen.add(r.id);
    const c = finalCategory(r);
    byCategory[c]++;
    ids[r.id] = c;
  }
  return { total: seen.size, duplicates, byCategory, ids };
}
