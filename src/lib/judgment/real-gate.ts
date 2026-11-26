/**
 * 統合AI判断の実AI評価の関門（Stage 10E 追加修正・純粋な判定）。**すべての条件を満たさない限り、実APIには接続しない**。
 *  - 開発環境（TOREMANE_ENV=local）でのみ。本番（Vercel）では使えない
 *  - この評価専用の許可（JUDGMENT_REAL_EVAL=allow）。他の実AI機能（調査エージェント等）の許可では有効にならない
 *  - APIキーの決め方（値は表示・記録しない。採用した「名前」だけを返す）:
 *      1. 評価専用キー JUDGMENT_EVAL_API_KEY があれば、それを使う（両方設定されている場合も常にこちらが優先）。
 *         ただし既存の ANTHROPIC_API_KEY と同じ値なら、再利用の明示許可（下記）が無い限り拒否する
 *      2. 評価専用キーが無い場合: JUDGMENT_REUSE_EXISTING_KEY=allow（開発環境限定の明示的なオプトイン）があるときだけ、既存のキーを再利用する。
 *         既存のキー = ANTHROPIC_API_KEY があればそれ、無ければ開発専用に設定済みのキー（実行スクリプトが JUDGMENT_REUSE_FALLBACK_KEY として渡す）
 *      3. オプトインが無い場合、評価専用キーが未設定・既存キーと同一・既存キーだけが設定、はいずれも拒否（従来どおり）
 *    再利用は、秘密のコピー・新規発行を要求しない。キーが共用になるため、**評価コードが管理する累積費用（上限30円）と、同じキーを使う他の処理を含むAPI側の請求額は別物**。
 *    共用キーが漏れた場合は、評価以外の機能にも影響する（キーの失効・再発行が必要）
 *  - Vercel・本番の実行環境（VERCEL・VERCEL_ENV・NODE_ENV=production）では常に拒否
 *  - 承認された総額・1件あたりの上限（円）。承認の値が、この評価の既定の候補上限（総額60円・1件5円）を超えるときは拒否（候補上限の引き上げには再承認が必要）
 *  - 実行ごとの確認（confirm）
 * 既定は何も設定されていない＝実APIに接続しない。実行は、費用と条件を報告してユーザーが承認したあとに限る。
 */
export const CANDIDATE_CAP_TOTAL_JPY = 60;
export const CANDIDATE_CAP_PER_CASE_JPY = 5;
const CANDIDATE_CAP_TOTAL_JPY_DEFAULT = CANDIDATE_CAP_TOTAL_JPY;
const CANDIDATE_CAP_PER_CASE_JPY_DEFAULT = CANDIDATE_CAP_PER_CASE_JPY;

export type KeySource = "dedicated" | "existing" | "existing_dev_fallback";
export type JudgmentRealGate = { ok: true; apiKey: string; keySource: KeySource; model: string; totalCapJpy: number; perCaseCapJpy: number } | { ok: false; reason: string };

/**
 * 実案件の集中評価（Phase 3 INTENSIVE_EVALUATION）の候補上限。本番シャドーと同じ判断構成（適応型: 必要時だけ上位モデル）を測るため、1件の上限は利用者が承認した1件¥25（2026-11-26）に合わせる。
 * 1回の実行の総額は従来どおり60円まで（小さなバッチに分けて実行し、通算は利用者の承認額の範囲に収める）。この上限は集中評価の入口（intensive-eval.real.test.ts）だけが渡す。
 */
export const INTENSIVE_CAPS = { totalJpy: 60, perCaseJpy: 25 } as const;

export function checkJudgmentRealRun(input: { env: Record<string, string | undefined>; confirm: boolean; approvedTotalJpy: number; approvedPerCaseJpy: number; caps?: { totalJpy: number; perCaseJpy: number } }): JudgmentRealGate {
  const CANDIDATE_CAP_TOTAL_JPY = input.caps?.totalJpy ?? CANDIDATE_CAP_TOTAL_JPY_DEFAULT;
  const CANDIDATE_CAP_PER_CASE_JPY = input.caps?.perCaseJpy ?? CANDIDATE_CAP_PER_CASE_JPY_DEFAULT;
  const e = input.env;
  if (e.TOREMANE_ENV !== "local") return { ok: false, reason: "実AI評価は開発環境（TOREMANE_ENV=local）でのみ実行できます" };
  if (e.VERCEL || e.VERCEL_ENV || e.NODE_ENV === "production") return { ok: false, reason: "Vercel・本番の実行環境では実行できません" };
  if (e.JUDGMENT_REAL_EVAL !== "allow") return { ok: false, reason: "この評価は許可されていません（JUDGMENT_REAL_EVAL=allow が必要）" };
  const dedicated = e.JUDGMENT_EVAL_API_KEY?.trim() || "";
  const existing = e.ANTHROPIC_API_KEY?.trim() || "";
  const fallback = e.JUDGMENT_REUSE_FALLBACK_KEY?.trim() || "";
  const reuse = e.JUDGMENT_REUSE_EXISTING_KEY === "allow";
  let key = "";
  let keySource: KeySource = "dedicated";
  if (dedicated) {
    if (existing && dedicated === existing && !reuse) return { ok: false, reason: "評価専用のキーが既存のキー（ANTHROPIC_API_KEY）と同じです。別のキーを使うか、再利用を明示許可（JUDGMENT_REUSE_EXISTING_KEY=allow）してください" };
    key = dedicated;
  } else if (reuse) {
    if (existing) { key = existing; keySource = "existing"; }
    else if (fallback) { key = fallback; keySource = "existing_dev_fallback"; }
    else return { ok: false, reason: "再利用できる既存のキーが見つかりません（ANTHROPIC_API_KEY または開発用に設定済みのキーが必要）" };
  } else if (existing) return { ok: false, reason: "評価専用のキー（JUDGMENT_EVAL_API_KEY）が未設定です。既存のキーを使うには JUDGMENT_REUSE_EXISTING_KEY=allow が必要です" };
  else return { ok: false, reason: "評価専用のAPIキー（JUDGMENT_EVAL_API_KEY）が未設定です" };
  const total = input.approvedTotalJpy;
  const per = input.approvedPerCaseJpy;
  if (!(total > 0) || !(per > 0) || !Number.isFinite(total) || !Number.isFinite(per)) return { ok: false, reason: "承認された総額と1件あたりの上限（円）が必要です" };
  if (per > total) return { ok: false, reason: "1件あたりの上限が総額を超えています" };
  if (total > CANDIDATE_CAP_TOTAL_JPY || per > CANDIDATE_CAP_PER_CASE_JPY) return { ok: false, reason: `承認額が候補上限（総額${CANDIDATE_CAP_TOTAL_JPY}円・1件${CANDIDATE_CAP_PER_CASE_JPY}円）を超えています。上限の引き上げは再承認が必要です` };
  if (!input.confirm) return { ok: false, reason: "実行前の確認が必要です（費用がかかります）" };
  return { ok: true, apiKey: key, keySource, model: e.AGENT_MODEL?.trim() || "claude-haiku-5-5", totalCapJpy: total, perCaseCapJpy: per };
}
