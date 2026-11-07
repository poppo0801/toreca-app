/** 商品の削除・統合の影響範囲の表示（純関数）。DB の product_reference_counts / merge_products(preview) の結果を整える */

export const REF_LABEL: Record<string, string> = {
  lottery_items: "抽選の商品",
  purchase_items: "購入明細",
  sales: "売却",
  box_lots: "BOXコレクション（購入ロット）",
  box_receipts: "BOXの受取記録",
  box_prices: "BOXの相場",
  card_masters: "コレクションのカード",
  set_items: "商品セットの構成",
  collection_memos: "優先収集メモ",
  collection_settings: "自動収集の商品指定",
  aliases: "別名",
  images: "画像",
  prices: "価格",
};

/** 履歴・データとして参照している項目（付属情報の別名・画像・価格は含めない） */
export const HISTORY_KEYS = ["lottery_items", "purchase_items", "sales", "box_lots", "box_receipts", "box_prices", "card_masters", "set_items", "collection_memos", "collection_settings"] as const;

export type RefCounts = Record<string, number>;

export function historyTotal(c: RefCounts): number {
  return HISTORY_KEYS.reduce((a, k) => a + (c[k] ?? 0), 0);
}

/** 0件を除いた「項目 N件」の並び */
export function refLines(c: RefCounts, keys: readonly string[] = Object.keys(REF_LABEL)): string[] {
  return keys.filter((k) => (c[k] ?? 0) > 0).map((k) => `${REF_LABEL[k] ?? k} ${c[k]}件`);
}

const MERGE_ERRORS: Record<string, string> = {
  "product code mismatch": "商品コードが異なるため統合できません（別の商品の可能性があります）",
  "product kind mismatch": "商品区分が異なるため統合できません",
  "packs per box mismatch": "1BOXあたりのパック数が異なるため統合できません",
  "set composition conflict": "セット構成で互いに含まれているため統合できません",
  "target product is archived": "統合先の商品が非表示です。先に再表示してください",
  "invalid products": "統合元と統合先が同じです",
  "merge verification failed": "統合後の照合が合わなかったため、何も変更していません",
  "product is referenced": "この商品は抽選・購入・コレクションなどから参照されているため削除できません",
};

export function mergeErrorText(message: string): string {
  const hit = Object.keys(MERGE_ERRORS).find((k) => message.includes(k));
  return hit ? MERGE_ERRORS[hit] : message;
}
