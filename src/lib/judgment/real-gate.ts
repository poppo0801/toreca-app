/**
 * 統合AI判断の実AI評価の関門（Stage 10E 追加修正・純粋な判定）。**すべての条件を満たさない限り、実APIには接続しない**。
 *  - 開発環境（TOREMANE_ENV=local）でのみ。本番（Vercel）では使えない
 *  - この評価専用の許可（JUDGMENT_REAL_EVAL=allow）。他の実AI機能（調査エージェント等）の許可では有効にならない
 *  - 開発専用のAPIキー（JUDGMENT_EVAL_API_KEY）。本番の ANTHROPIC_API_KEY と同じ値なら拒否
 *  - 承認された総額・1件あたりの上限（円）。承認の値が、この評価の既定の候補上限（総額60円・1件5円）を超えるときは拒否（候補上限の引き上げには再承認が必要）
 *  - 実行ごとの確認（confirm）
 * 既定は何も設定されていない＝実APIに接続しない。実行は、費用と条件を報告してユーザーが承認したあとに限る。
 */
export const CANDIDATE_CAP_TOTAL_JPY = 60;
export const CANDIDATE_CAP_PER_CASE_JPY = 5;

export type JudgmentRealGate = { ok: true; apiKey: string; model: string; totalCapJpy: number; perCaseCapJpy: number } | { ok: false; reason: string };

export function checkJudgmentRealRun(input: { env: Record<string, string | undefined>; confirm: boolean; approvedTotalJpy: number; approvedPerCaseJpy: number }): JudgmentRealGate {
  const e = input.env;
  if (e.TOREMANE_ENV !== "local") return { ok: false, reason: "実AI評価は開発環境（TOREMANE_ENV=local）でのみ実行できます" };
  if (e.JUDGMENT_REAL_EVAL !== "allow") return { ok: false, reason: "この評価は許可されていません（JUDGMENT_REAL_EVAL=allow が必要）" };
  const key = e.JUDGMENT_EVAL_API_KEY?.trim();
  if (!key) return { ok: false, reason: "開発専用のAPIキー（JUDGMENT_EVAL_API_KEY）が未設定です" };
  if (e.ANTHROPIC_API_KEY?.trim() && e.ANTHROPIC_API_KEY.trim() === key) return { ok: false, reason: "開発専用のキーが本番のキー（ANTHROPIC_API_KEY）と同じです。別のキーを使ってください" };
  const total = input.approvedTotalJpy;
  const per = input.approvedPerCaseJpy;
  if (!(total > 0) || !(per > 0) || !Number.isFinite(total) || !Number.isFinite(per)) return { ok: false, reason: "承認された総額と1件あたりの上限（円）が必要です" };
  if (per > total) return { ok: false, reason: "1件あたりの上限が総額を超えています" };
  if (total > CANDIDATE_CAP_TOTAL_JPY || per > CANDIDATE_CAP_PER_CASE_JPY) return { ok: false, reason: `承認額が候補上限（総額${CANDIDATE_CAP_TOTAL_JPY}円・1件${CANDIDATE_CAP_PER_CASE_JPY}円）を超えています。上限の引き上げは再承認が必要です` };
  if (!input.confirm) return { ok: false, reason: "実行前の確認が必要です（費用がかかります）" };
  return { ok: true, apiKey: key, model: e.AGENT_MODEL?.trim() || "claude-haiku-5-5", totalCapJpy: total, perCaseCapJpy: per };
}
