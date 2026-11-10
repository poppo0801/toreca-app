import { missingBadges } from "@/lib/collector/missing-badges";

/**
 * 抽選候補の状態（Stage 7M）。確認・判断する場所を抽選候補ページに集約するための分類。
 *  - new: 取得から36時間以内
 *  - missing: 登録に必要な情報が不足している（不足情報バッジがある）
 *  - check: 要確認（要手動確認の案件・情報の矛盾・解析結果が無い取得失敗）
 *  - done: 確認済み（要手動確認を対応済みにした／不足も要確認も無く新着でもない）
 * 1つの候補が複数の状態に当てはまることがある（絞り込みはいずれかに該当すれば表示）。
 */
export type CandidateState = "new" | "missing" | "check" | "done";
export const CANDIDATE_STATE_LABEL: Record<CandidateState, string> = { new: "新着", missing: "情報不足", check: "要確認", done: "確認済み" };
export const CANDIDATE_STATES: CandidateState[] = ["new", "missing", "check", "done"];

export const NEW_HOURS = 36;

type Source = Omit<Parameters<typeof missingBadges>[0], "assess"> & {
  fetched_at: string;
  triage?: string | null;
  manual_state?: string | null;
  draft?: { input?: unknown } | null;
  assess?: { missing?: string; missingItems?: string[]; conflict?: unknown } | null;
};

export function candidateStates(c: Source, now: Date): Set<CandidateState> {
  const out = new Set<CandidateState>();
  const isNew = now.getTime() - new Date(c.fetched_at).getTime() < NEW_HOURS * 3600_000;
  const manualOpen = c.triage === "manual" && c.manual_state === "open";
  const check = manualOpen || !!c.assess?.conflict || !c.draft?.input;
  const missing = missingBadges(c).length > 0;
  if (isNew) out.add("new");
  if (missing) out.add("missing");
  if (check) out.add("check");
  if (c.manual_state === "resolved" || (!missing && !check && !isNew)) out.add("done");
  return out;
}
