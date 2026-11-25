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

/** 収集時に、取得した全文を evidence_documents（migration 115）へ保存するか。新AI機能と同じ開発限定の条件（本番では常にfalse。115 が未適用の本番表へは書かない） */
export function evidenceCollectStoreEnabled(env: Env = process.env): boolean {
  return proposalPreviewEnabled(env) && env.EVIDENCE_COLLECT_STORE !== "off";
}

/** 未取得リンクの自動再調査（耐久キュー）を使うか。新AI機能と同じ開発限定の条件（本番では常にfalse。122 が未適用の本番表へは書かない） */
export function linkRecheckEnabled(env: Env = process.env): boolean {
  return proposalPreviewEnabled(env) && env.LINK_RECHECK !== "off";
}

/** ホスト別の取得制御をDB共有（複数インスタンス）にするか。開発限定（既定は off＝プロセス内）。DB版は migration 122 が必要 */
export function dbHostGateEnabled(env: Env = process.env): boolean {
  return proposalPreviewEnabled(env) && env.FETCH_GATE === "db";
}

/** 収集（run.ts）からの自動生成を許可するか（さらに別のフラグ。既定OFF。手動の生成だけ使うなら不要） */
export function proposalAutoGenerateEnabled(env: Env = process.env): boolean {
  return proposalPreviewEnabled(env) && env.PROPOSAL_AUTO === "on";
}
