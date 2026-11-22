/**
 * 将来の「本番での限定プレビュー」の許可判定（Phase 2・**設計の実装。どこにも接続しない・本番では有効化しない**）。
 * 現在の登録案プレビュー（flag.ts）はローカルのSupabaseでしか動かない。本番で動かすには、別の承認・別のコード変更（この判定を呼ぶ入口）が要る。ここは、その入口が満たすべき条件を**純関数とテスト**として固定しておく。
 * 既定はすべてOFF。次の**すべて**が揃うときだけ許可する（どれかが欠ければ拒否。理由コードを返す）:
 *  1. 本番の実行環境（VERCEL_ENV=production）であること＝ローカル／プレビュー環境では、本番用のスイッチが立っていても許可しない（誤起動の防止。逆に、flag.ts のローカル用の許可は本番では常に拒否）
 *  2. PROPOSAL_PROD_PREVIEW=on（スイッチ1）かつ PROPOSAL_PROD_APPROVED=yes（スイッチ2。承認を表す）
 *  3. 緊急停止（PROPOSAL_KILL=1|on）が立っていない。DB側の設定（kill）も立っていない。**どちらか一方でも停止で、再デプロイ不要で即時にOFFに戻せる（DB側）**
 *  4. 対象世帯が許可リスト（PROPOSAL_PROD_HOUSEHOLDS＝カンマ区切りのID）に含まれる（限定運用。全世帯への既定の有効化はしない）
 *  5. 専用の予算がある（PROPOSAL_DAILY_BUDGET_JPY > 0 かつ 本日の使用額が未満）。既存の自律型・再評価AIの予算とは別
 *  6. 専用のAPIキー（PROPOSAL_ANTHROPIC_API_KEY）があり、他の用途のキー（呼び出し側が otherKeys として渡す）と**別の値**であること（キーの流用・共用で費用が混ざらない）
 *  7. 自動登録・通知連動はこの許可の対象外（`autoRegister`・`notify` は常に false。人のレビューつきのプレビューだけ）
 */
type Env = Record<string, string | undefined>;
const on = (v: string | undefined): boolean => v === "on" || v === "1" || v === "yes";

export interface ProdPreviewInput {
  env: Env;
  householdId: string;
  /** DB側の設定（将来の proposal_settings）。未設定=無効 */
  settings: { enabled: boolean; kill: boolean } | null;
  usage: { todayJpy: number };
  /** 他の機能が使っているAPIキーの値（共用の検出用。呼び出し側が集めて渡す。この判定は他機能の環境変数名を知らない） */
  otherKeys?: string[];
}

export type ProdPreviewDecision = { allowed: true; autoRegister: false; notify: false; budgetJpy: number } | { allowed: false; reasons: string[] };

export function productionPreviewPermission(i: ProdPreviewInput): ProdPreviewDecision {
  const e = i.env;
  const reasons: string[] = [];
  if (e.VERCEL_ENV !== "production") reasons.push("not_production_environment");
  if (!on(e.PROPOSAL_PROD_PREVIEW)) reasons.push("switch1_off");
  if (e.PROPOSAL_PROD_APPROVED !== "yes") reasons.push("switch2_not_approved");
  if (on(e.PROPOSAL_KILL)) reasons.push("killed_by_env");
  if (!i.settings) reasons.push("no_db_settings");
  else {
    if (!i.settings.enabled) reasons.push("db_disabled");
    if (i.settings.kill) reasons.push("killed_by_db");
  }
  const allow = (e.PROPOSAL_PROD_HOUSEHOLDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!allow.includes(i.householdId)) reasons.push("household_not_allowed");
  const budget = Number(e.PROPOSAL_DAILY_BUDGET_JPY);
  if (!(budget > 0)) reasons.push("no_dedicated_budget");
  else if (i.usage.todayJpy >= budget) reasons.push("budget_exhausted");
  const key = (e.PROPOSAL_ANTHROPIC_API_KEY ?? "").trim();
  if (key.length < 20) reasons.push("no_dedicated_key");
  else if ((i.otherKeys ?? []).some((k) => k.trim() && k.trim() === key)) reasons.push("key_shared_with_other_feature");
  return reasons.length ? { allowed: false, reasons } : { allowed: true, autoRegister: false, notify: false, budgetJpy: budget };
}
