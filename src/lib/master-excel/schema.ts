/**
 * 商品・店舗マスターのExcel入出力の列定義。テンプレート・エクスポート・取り込みで同じ定義を使う。
 * 更新の規則: 空欄=変更しない / 値あり=その値に変更 / `#CLEAR`=削除（clearable の項目だけ）。
 */
export type MasterKind = "products" | "stores";

export const TEMPLATE_VERSION = 1;
/** ファイルがトレマネのテンプレートか・種類・版を判定するための印（ブックのキーワードに入れる） */
export const templateMarker = (kind: MasterKind) => `toremane-master-import:${kind}:v${TEMPLATE_VERSION}`;
export const CLEAR_TOKEN = "#CLEAR";
export const ALIAS_SEPARATOR = "|";

export const MAX_FILE_BYTES = 4_000_000; // Vercel の本文上限(4.5MB)より小さくする
export const MAX_DATA_ROWS = 2000;

export const SHEET = {
  guide: "使い方",
  products: "商品",
  components: "セット構成",
  stores: "店舗",
  examples: "記入例",
} as const;

export interface ColumnDef {
  key: string;
  label: string;
  /** 新規行で必須 */
  requiredForNew?: boolean;
  /** `#CLEAR` で削除できる */
  clearable: boolean;
  /** 記入のルール（テンプレートの説明・列の注釈に使う） */
  note: string;
  width: number;
}

export const PRODUCT_COLUMNS: readonly ColumnDef[] = [
  { key: "management_no", label: "管理番号", clearable: false, note: "既存の行は変更しない（PR000001形式）。新規の行は空欄にすると自動で付きます", width: 14 },
  { key: "product_code", label: "商品コード", clearable: true, note: "任意。大文字小文字は区別せず、同じコードは1つだけ", width: 14 },
  { key: "code_kind", label: "コード種別", clearable: false, note: "「公式」または「独自」。商品コードを入れる新規行では必須", width: 12 },
  { key: "official_name", label: "正式名称", requiredForNew: true, clearable: false, note: "新規の行では必須（120文字まで）", width: 36 },
  { key: "aliases", label: "略称", clearable: true, note: `複数は ${ALIAS_SEPARATOR} で区切る。入力すると、この商品の略称がその内容に置き換わります`, width: 24 },
  { key: "product_group", label: "商品グループ", clearable: true, note: "任意（60文字まで）", width: 16 },
  { key: "release_date", label: "発売日", clearable: true, note: "YYYY-MM-DD 形式", width: 12 },
  { key: "category", label: "カテゴリ", clearable: false, note: "40文字まで。新規の行で空欄なら「pokemon_card」", width: 14 },
  { key: "packs_per_box", label: "BOX入数", clearable: true, note: "1〜500の整数（1BOXのパック数）", width: 10 },
  { key: "list_price_box", label: "BOX定価", clearable: true, note: "円。0以上の整数", width: 10 },
  { key: "list_price_pack", label: "パック定価", clearable: true, note: "円。0以上の整数", width: 10 },
  { key: "memo", label: "メモ", clearable: true, note: "2000文字まで", width: 30 },
];

export const COMPONENT_COLUMNS: readonly ColumnDef[] = [
  { key: "set_no", label: "セット商品の管理番号", requiredForNew: true, clearable: false, note: "既存の商品の管理番号", width: 22 },
  { key: "component_no", label: "構成商品の管理番号", requiredForNew: true, clearable: false, note: "既存の商品の管理番号", width: 22 },
  { key: "quantity", label: "数量", requiredForNew: true, clearable: false, note: "1〜999。ここに無い構成は変更・削除されません", width: 8 },
];

export const STORE_COLUMNS: readonly ColumnDef[] = [
  { key: "management_no", label: "管理番号", clearable: false, note: "既存の行は変更しない（ST000001形式）。新規の行は空欄にすると自動で付きます", width: 14 },
  { key: "chain", label: "系列", requiredForNew: true, clearable: false, note: "登録済みの系列名。既存の店舗の系列は変更できません", width: 18 },
  { key: "name", label: "店舗名", requiredForNew: true, clearable: false, note: "80文字まで。同じ系列で同じ店舗名は登録できません", width: 24 },
  { key: "prefecture", label: "都道府県", clearable: true, note: "例: 兵庫県", width: 10 },
  { key: "address", label: "住所", clearable: true, note: "店舗の住所（200文字まで）。変更すると位置情報の再確認が必要になります", width: 36 },
  { key: "store_url", label: "店舗URL", clearable: true, note: "http:// または https:// で始まるURL", width: 30 },
  { key: "round_trip_fare", label: "往復交通費", clearable: true, note: "円。0〜1000000の整数", width: 12 },
  { key: "apply_method", label: "応募方法", clearable: true, note: "Web / 店頭 / アプリ", width: 10 },
  { key: "receive_method", label: "受取方法", clearable: true, note: "店頭 / 配送 / どちらでも", width: 12 },
  { key: "memo", label: "メモ", clearable: true, note: "1000文字まで", width: 30 },
];

export const CODE_KIND_LABEL: Record<string, string> = { official: "公式", custom: "独自" };
export const APPLY_METHOD_LABEL: Record<string, string> = { web: "Web", store: "店頭", app: "アプリ" };
export const RECEIVE_METHOD_LABEL: Record<string, string> = { store: "店頭", shipping: "配送", either: "どちらでも" };

export const columnsOf = (kind: MasterKind) => (kind === "products" ? PRODUCT_COLUMNS : STORE_COLUMNS);
export const dataSheetName = (kind: MasterKind) => (kind === "products" ? SHEET.products : SHEET.stores);

/** 行の結果の種類 */
export type RowStatus = "new" | "update" | "unchanged" | "error";

export interface RowIssue {
  sheet: string;
  /** Excelの行番号（見出しが1行目） */
  row: number;
  column: string;
  message: string;
}

export interface FieldChange {
  column: string;
  before: string;
  after: string;
}

export interface PreviewRow {
  sheet: string;
  row: number;
  /** 管理番号（新規は空） */
  no: string | null;
  /** 一覧で見分けるための名前 */
  label: string;
  status: RowStatus;
  changes: FieldChange[];
  errors: RowIssue[];
  /** 補足（位置情報の再確認が必要など） */
  notes: string[];
}

export interface PreviewCounts {
  new: number;
  update: number;
  unchanged: number;
  error: number;
}

export interface PreviewResult {
  kind: MasterKind;
  counts: PreviewCounts;
  /** セット構成シートの件数（商品のみ） */
  components?: PreviewCounts;
  rows: PreviewRow[];
  /** 1件でもエラーがあれば適用できない（一部だけの適用はしない） */
  applicable: boolean;
  /** 適用時にサーバーが同じ内容か確認するための指紋。エラーがあれば空 */
  fingerprint: string;
}

/** 1シート分の読み取り結果（セルはすべて文字列。空欄は空文字） */
export interface Grid {
  sheet: string;
  /** 見出し（列キー → Excelの列位置）。見つからなかった列は含まない */
  columns: Record<string, number>;
  rows: { row: number; cells: Record<string, string> }[];
}
