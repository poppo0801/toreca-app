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
  /** 一覧の短い分類名（Stage 6R）。フォームの品目名（label）とは別 */
  short: string;
  /** 分類色（CSS 変数。globals.css の --cat-*） */
  color: string;
}

export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  { id: "pokemon_card", label: "ポケモンカード", master: true, quantity: true, channel: true, itemLabel: "商品", itemPlaceholder: "", short: "カード", color: "var(--cat-card)" },
  // シングルカード（Stage 7E）: 単品のカード。数量の単位は「枚」に固定（保存は個=piece、表示は枚）。商品マスターとは連携せず、カード名などを自由入力
  { id: "single_card", label: "シングルカード", master: false, quantity: true, channel: true, itemLabel: "カード名", itemPlaceholder: "例: ピカチュウ SAR", short: "シングル", color: "var(--cat-single)" },
  { id: "goods", label: "周辺グッズ", master: false, quantity: true, channel: true, itemLabel: "品名", itemPlaceholder: "例: スリーブ、ローダー、ファイル", short: "サプライ", color: "var(--cat-supply)" },
  { id: "expense", label: "経費", master: false, quantity: false, channel: false, itemLabel: "内容", itemPlaceholder: "例: 交通費、駐車場代、送料", short: "経費", color: "var(--cat-expense)" },
  // その他（Stage 7E）: 既存の品目に当てはまらない支出。購入記録の集計項目「その他商品」（デッキ・セット商品）とは別のもの
  { id: "other", label: "その他", master: false, quantity: true, channel: true, itemLabel: "品名", itemPlaceholder: "", short: "その他", color: "var(--cat-other)" },
];

export const DEFAULT_EXPENSE_CATEGORY = "pokemon_card";
export const EXPENSE_CATEGORY_IDS = EXPENSE_CATEGORIES.map((c) => c.id) as [string, ...string[]];

/** 未知の区分（将来追加された品目など）も、ラベルはIDのまま表示し、カード扱いにはしない */
export function categoryOf(id: string | null | undefined): ExpenseCategory {
  const key = id ?? DEFAULT_EXPENSE_CATEGORY;
  return EXPENSE_CATEGORIES.find((c) => c.id === key) ?? { id: key, label: key, master: false, quantity: true, channel: true, itemLabel: "品名", itemPlaceholder: "", short: key, color: "var(--muted-foreground)" };
}

/** ポケモンカードの購入か（購入実績・カード数量・購入条件の集計の対象） */
export const isCardPurchase = (p: { category?: string | null }): boolean => (p.category ?? DEFAULT_EXPENSE_CATEGORY) === DEFAULT_EXPENSE_CATEGORY;

/** 数量の単位を「枚」に固定する品目（シングルカード） */
export const isSingleCard = (category: string | null | undefined): boolean => category === "single_card";

/** 購入記録（購入履歴・商品別累計）に載せる品目: ポケモンカード・シングルカード・その他。周辺グッズ・経費は収支にだけ計上する（Stage 7E） */
export const PURCHASE_RECORD_CATEGORIES = ["pokemon_card", "single_card", "other"] as const;
export const isPurchaseRecord = (p: { category?: string | null }): boolean => (PURCHASE_RECORD_CATEGORIES as readonly string[]).includes(p.category ?? DEFAULT_EXPENSE_CATEGORY);
