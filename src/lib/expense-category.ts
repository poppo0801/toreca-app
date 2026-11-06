/**
 * 支出の品目区分（Stage 6K）。区分は文字列でDBに保存し、ここの定義に1行足せば品目を増やせる（DBは形式だけを制限）。
 *  - master: 商品マスター・購入実績と連携する品目（ポケモンカード）。連携しない品目は自由入力で、購入実績・カード数量には含めない
 *  - unit: 数量・単位の入力欄を出すか（経費は金額中心なので出さない）
 */
export interface ExpenseCategory {
  id: string;
  label: string;
  /** 商品マスターと連携し、購入実績（BOX数・枚数など）に含める */
  master: boolean;
  /** 数量・単位の入力欄を出す */
  quantity: boolean;
  /** 購入方法（店頭・通販など）の入力欄を出す */
  channel: boolean;
  /** 品名の入力欄の見出し */
  itemLabel: string;
  itemPlaceholder: string;
}

export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  { id: "pokemon_card", label: "ポケモンカード", master: true, quantity: true, channel: true, itemLabel: "商品", itemPlaceholder: "" },
  { id: "goods", label: "カード周辺グッズ", master: false, quantity: true, channel: true, itemLabel: "品名", itemPlaceholder: "例: スリーブ、ローダー、ファイル" },
  { id: "expense", label: "経費", master: false, quantity: false, channel: false, itemLabel: "内容", itemPlaceholder: "例: 交通費、駐車場代、送料" },
];

export const DEFAULT_EXPENSE_CATEGORY = "pokemon_card";
export const EXPENSE_CATEGORY_IDS = EXPENSE_CATEGORIES.map((c) => c.id) as [string, ...string[]];

/** 未知の区分（将来追加された品目など）も、ラベルはIDのまま表示し、カード扱いにはしない */
export function categoryOf(id: string | null | undefined): ExpenseCategory {
  const key = id ?? DEFAULT_EXPENSE_CATEGORY;
  return EXPENSE_CATEGORIES.find((c) => c.id === key) ?? { id: key, label: key, master: false, quantity: true, channel: true, itemLabel: "品名", itemPlaceholder: "" };
}

/** ポケモンカードの購入か（購入実績・カード数量・購入条件の集計の対象） */
export const isCardPurchase = (p: { category?: string | null }): boolean => (p.category ?? DEFAULT_EXPENSE_CATEGORY) === DEFAULT_EXPENSE_CATEGORY;
