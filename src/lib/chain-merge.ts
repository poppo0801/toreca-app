/** 系列の削除・統合の影響範囲の表示（純関数）。DB の chain_reference_counts / merge_chain_masters(preview) の結果を整える */

export const CHAIN_REF_LABEL: Record<string, string> = {
  stores: "店舗",
  lotteries: "抽選",
  campaigns: "キャンペーン",
  service_accounts: "使用中の応募アカウント",
  eligibilities: "応募条件の充足（資格）の記録",
  applications: "応募記録",
  member_numbers: "会員番号",
  purchases: "購入記録",
  box_lots: "BOXコレクション（購入ロット）",
  box_receipts: "BOXの受取記録",
  application_rules: "応募ルール",
  chain_requirements: "応募条件",
  chain_conditions: "抽選条件",
  profile_target_rules: "対象設定",
  skip_rules: "スルー設定",
  collection_settings: "自動収集の設定・メモ",
  x_accounts: "Xアカウントの対応",
  trip_distances: "ガソリン代の片道距離",
  aliases: "別名",
};

/** 削除をブロックする参照（別名は系列自身の付属情報なので含めない） */
export const CHAIN_HISTORY_KEYS = Object.keys(CHAIN_REF_LABEL).filter((k) => k !== "aliases");

export type ChainRefCounts = Record<string, number>;

export function chainRefTotal(c: ChainRefCounts): number {
  return CHAIN_HISTORY_KEYS.reduce((a, k) => a + (c[k] ?? 0), 0);
}

export function chainRefLines(c: ChainRefCounts, keys: readonly string[] = CHAIN_HISTORY_KEYS): string[] {
  return keys.filter((k) => (c[k] ?? 0) > 0).map((k) => `${CHAIN_REF_LABEL[k] ?? k} ${c[k]}件`);
}

const ERRORS: Record<string, string> = {
  "member numbers conflict": "同じユーザーの会員番号が両方の系列にあるため統合できません（先にどちらかを整理してください）",
  "requirement label conflict": "同じ名前の応募条件が両方の系列にあるため統合できません（先に整理してください）",
  "application rule conflict": "同じ区分の応募ルールが両方の系列にあるため統合できません（先に整理してください）",
  "target rule conflict": "ユーザーの対象設定（許可/除外）が両方の系列で食い違うため統合できません",
  "eligibility records exist": "応募条件の充足（資格）の記録がある系列は統合できません（先に資格の記録を整理してください）",
  "target chain is archived": "統合先の系列が非表示です。先に再表示してください",
  "invalid chains": "統合元と統合先が同じです",
  "merge verification failed": "統合後の照合が合わなかったため、何も変更していません",
  "chain is referenced": "この系列は店舗・抽選・購入などから参照されているため削除できません",
};

export function chainMergeErrorText(message: string): string {
  const hit = Object.keys(ERRORS).find((k) => message.includes(k));
  return hit ? ERRORS[hit] : message;
}
