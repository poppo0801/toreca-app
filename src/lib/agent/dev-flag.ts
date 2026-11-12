/**
 * 開発用の調査画面・調査アクションを有効にするか（Stage 8D-2）。開発環境（next dev、または TOREMANE_ENV=local）のみ。
 * 本番（Vercel）ではどちらも成り立たないため、画面は 404、アクションは拒否される（本番の挙動は変わらない）。
 */
export function isStoreResearchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development" || env.TOREMANE_ENV === "local";
}

/**
 * 反映候補の承認（店舗マスターへの反映・取消）を許可するか（Stage 8D-4）。**開発環境（TOREMANE_ENV=local）だけ**。
 * `next dev` だけでは許可しない（接続先を取り違えても本番の店舗マスターに書かない）。本番（Vercel）では常に拒否される。
 * 本番への導入は、旧方式との比較検証・利用者の承認・マイグレーション適用のあとに、別の段階で検討する。
 */
export function canApplyToStoreMaster(env: Record<string, string | undefined> = process.env): boolean {
  return env.TOREMANE_ENV === "local";
}
