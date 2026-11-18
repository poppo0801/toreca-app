/**
 * 抽選グループのAI判定（Stage 8F）を有効にするかの判定。純粋な関数。
 * **開発環境（TOREMANE_ENV=local）だけ**。`next dev` だけでは有効にしない（接続先を取り違えても、本番のデータをグループ化しない）。
 * 本番（Vercel）では TOREMANE_ENV が設定されないため、判定・自動グループ化・承認の画面は常に無効（本番の挙動は変わらない）。
 * 本番への導入は、旧方式（手動グループ）との比較検証・利用者の承認・マイグレーション適用のあとに、別の段階で検討する。
 */
export function isLotteryGroupingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TOREMANE_ENV === "local";
}

/** 自動グループ化（検証層が auto と判定した提案の実行）を許可するか。開発環境の既定は有効。GROUPING_AUTO=off で止められる */
export function canAutoGroup(env: Record<string, string | undefined> = process.env): boolean {
  return isLotteryGroupingEnabled(env) && env.GROUPING_AUTO !== "off";
}
