/** 店舗の削除・統合の影響範囲の表示（純関数。Stage 7S）。DB の store_reference_counts の結果を整える */

export const STORE_REF_LABEL: Record<string, string> = {
  lotteries: "抽選",
  applications: "応募記録",
  purchases: "購入記録",
  box_lots: "BOXコレクション（購入ロット）",
  box_receipts: "BOXの受取記録",
  eligibility_purchases: "応募条件の購入実績",
  skip_rules: "スルー設定",
  profile_target_rules: "対象設定",
  collection_settings: "自動収集の設定・メモ",
  x_accounts: "Xアカウントの対応",
  trip_distances: "ガソリン代の片道距離",
  aliases: "別名",
};

/** 削除をブロックする参照（別名・距離は店舗自身の付属情報なので含めない） */
export const STORE_HISTORY_KEYS = Object.keys(STORE_REF_LABEL).filter((k) => k !== "aliases" && k !== "trip_distances");

export type StoreRefCounts = Record<string, number>;

export const storeRefTotal = (c: StoreRefCounts): number => STORE_HISTORY_KEYS.reduce((a, k) => a + (c[k] ?? 0), 0);

export const storeRefLines = (c: StoreRefCounts): string[] => STORE_HISTORY_KEYS.filter((k) => (c[k] ?? 0) > 0).map((k) => `${STORE_REF_LABEL[k]} ${c[k]}件`);

const ERRORS: Record<string, string> = {
  "store is referenced": "この店舗は抽選・応募・購入などから参照されているため削除できません（非表示にできます）",
  "stores are in different chains": "別の系列の店舗とは統合できません",
  "target store is archived": "統合先の店舗が非表示です。先に再表示してください",
  "merge verification failed": "統合後の照合が合わなかったため、何も変更していません",
  "invalid stores": "統合元と統合先が同じです",
};

export function storeAdminErrorText(message: string): string {
  const hit = Object.keys(ERRORS).find((k) => message.includes(k));
  return hit ? ERRORS[hit] : message;
}
