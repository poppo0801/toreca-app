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

/** 収集時に、取得した全文を evidence_documents（migration 115）へ保存するか。新AI機能と同じ開発限定の条件（本番では常にfalse。115 が未適用の本番表へは書かない） */
export function evidenceCollectStoreEnabled(env: Env = process.env): boolean {
  return proposalPreviewEnabled(env) && env.EVIDENCE_COLLECT_STORE !== "off";
}

/** 収集（run.ts）からの自動生成を許可するか（さらに別のフラグ。既定OFF。手動の生成だけ使うなら不要） */
export function proposalAutoGenerateEnabled(env: Env = process.env): boolean {
  return proposalPreviewEnabled(env) && env.PROPOSAL_AUTO === "on";
}
