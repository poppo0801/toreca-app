/**
 * 新AIの登録案プレビューの有効判定（Stage 10Z）。**既定OFF**。次がすべて揃うときだけ有効:
 *  - ローカル開発環境（TOREMANE_ENV=local）かつ 個別フラグ（PROPOSAL_PREVIEW=on）
 *  - 接続先が**ローカルのSupabase**（127.0.0.1／localhost）であること
 * Vercel（VERCEL／VERCEL_ENV）では常に無効。本番DB（ホスト型のSupabase）に繋がる環境では、環境変数が何であっても動かない（誤設定だけで新方式が有効にならない）。
 * ローカルの本番ビルド（next start。NODE_ENV=production）は、接続先がローカルなら動く（E2Eのため）。
 * 実AIの呼び出しはこのフラグの範囲外（実AIは承認済みの関門 `checkJudgmentRealRun` を通る評価ハーネスだけが呼ぶ。ここは費用ゼロのモード／保存済み入力の再生だけ）。
 */
type Env = Record<string, string | undefined>;

const LOCAL_SUPABASE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/;

export function proposalPreviewEnabled(env: Env = process.env): boolean {
  if (env.VERCEL || env.VERCEL_ENV) return false;
  if (!LOCAL_SUPABASE.test(env.NEXT_PUBLIC_SUPABASE_URL ?? "")) return false;
  return env.TOREMANE_ENV === "local" && env.PROPOSAL_PREVIEW === "on";
}

/**
 * 本番シャドー（Phase 3）の登録案を、管理画面で**読む**ことの許可。本番環境（VERCEL_ENV=production）で、本番の2つのスイッチ（PROPOSAL_PROD_PREVIEW=on・PROPOSAL_PROD_APPROVED=yes）が立ち、停止（PROPOSAL_KILL）が無いときだけ。
 * 登録案の生成は別（ワーカー）で、この許可には含まれない。レビュー（保留／却下／修正して承認）は記録だけで、抽選は登録されない。ローカル開発の許可（proposalPreviewEnabled）とは独立。
 */
export function proposalShadowViewEnabled(env: Env = process.env): boolean {
  const on = (v: string | undefined): boolean => v === "on" || v === "1" || v === "yes";
  return env.VERCEL_ENV === "production" && on(env.PROPOSAL_PROD_PREVIEW) && env.PROPOSAL_PROD_APPROVED === "yes" && !on(env.PROPOSAL_KILL);
}

/** 登録案を画面で読む・レビューを記録する許可（ローカル開発のプレビュー または 本番シャドーの閲覧） */
export function proposalSurfaceEnabled(env: Env = process.env): boolean {
  return proposalPreviewEnabled(env) || proposalShadowViewEnabled(env);
}

/**
 * 本番の証拠の取得・保存（PRODUCTION_PARITY）。**AIを呼ばない**（費用0）取得・保存だけの本番許可。以前は開発限定の条件（proposalPreviewEnabled）に依存し、本番では常に false だった
 * （本番シャドーの新AIが、収集時の全文・再取得したリンク先・画像の取得記録を一度も受け取れなかった）。次がすべて揃うときだけ:
 *  - 本番の実行環境（VERCEL_ENV=production）・本番シャドーの承認済みスイッチ（PROPOSAL_PROD_APPROVED=yes・SHADOW_WORKER_PRODUCTION_APPROVED=yes）
 *  - 停止が無い（PROPOSAL_KILL・SHADOW_WORKER_KILL・EVIDENCE_PROD=off のどれも立っていない）
 *  - 世帯が許可リスト（PROPOSAL_PROD_HOUSEHOLDS）に含まれる（householdId を渡したとき。限定運用）
 * 保存先（migration 115・122）は本番に適用済み。書き込みはサービス権限のみ（RLS）。抽選・応募・通知・履歴には書かない。開発のモック生成（proposalAutoGenerateEnabled）は本番では無効のまま。
 */
export function productionEvidenceEnabled(env: Env = process.env, householdId?: string): boolean {
  const on = (v: string | undefined): boolean => v === "on" || v === "1" || v === "yes";
  if (env.VERCEL_ENV !== "production") return false;
  if (env.PROPOSAL_PROD_APPROVED !== "yes" || env.SHADOW_WORKER_PRODUCTION_APPROVED !== "yes") return false;
  if (on(env.PROPOSAL_KILL) || on(env.SHADOW_WORKER_KILL) || env.EVIDENCE_PROD === "off") return false;
  if (householdId !== undefined) {
    const allow = (env.PROPOSAL_PROD_HOUSEHOLDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!allow.includes(householdId)) return false;
  }
  return true;
}

/** 収集時に、取得した全文を evidence_documents（migration 115）へ保存するか。開発（新AI機能が有効）または本番の証拠保存の許可 */
export function evidenceCollectStoreEnabled(env: Env = process.env, householdId?: string): boolean {
  if (env.EVIDENCE_COLLECT_STORE === "off") return false;
  return proposalPreviewEnabled(env) || productionEvidenceEnabled(env, householdId);
}

/** 未取得リンクの自動再調査（耐久キュー・migration 122）を使うか。開発（新AI機能が有効）または本番の証拠保存の許可。取得のみ（AIは呼ばない） */
export function linkRecheckEnabled(env: Env = process.env, householdId?: string): boolean {
  if (env.LINK_RECHECK === "off") return false;
  return proposalPreviewEnabled(env) || productionEvidenceEnabled(env, householdId);
}

/** ホスト別の取得制御をDB共有（複数インスタンス）にするか。開発限定（既定は off＝プロセス内）。DB版は migration 122 が必要 */
export function dbHostGateEnabled(env: Env = process.env): boolean {
  return proposalPreviewEnabled(env) && env.FETCH_GATE === "db";
}

/** 収集（run.ts）からの自動生成を許可するか（さらに別のフラグ。既定OFF。手動の生成だけ使うなら不要） */
export function proposalAutoGenerateEnabled(env: Env = process.env): boolean {
  return proposalPreviewEnabled(env) && env.PROPOSAL_AUTO === "on";
}
