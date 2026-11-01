/**
 * 抽選情報Excel（3シート）の列定義。テンプレート・ダウンロード・取り込みで同じ定義を使う。
 * 更新の規則（マスターExcelと同じ）: 空欄=変更しない / 値あり=その値に変更 / `#CLEAR`=削除（clearable の項目だけ）。
 * ファイルに無い抽選は変更も削除もしない。行を削除する取り込みはない。
 */
import type { ColumnDef } from "@/lib/master-excel/schema";
import { ANNOUNCE_METHODS, ANNOUNCE_TARGETS, REQUIREMENT_TAGS } from "@/lib/lottery-taxonomy";

export type { ColumnDef };

export const LOTTERY_TEMPLATE_VERSION = 1;
export const LOTTERY_MARKER = `toremane-lottery-import:v${LOTTERY_TEMPLATE_VERSION}`;
export const LIST_SEPARATOR = "|";
export const MAX_LOTTERY_ROWS = 2000;
export const MAX_CHILD_ROWS = 6000;

export const LSHEET = {
  guide: "使い方",
  lotteries: "抽選情報",
  items: "対象商品",
  apps: "応募・当落履歴",
  meta: "出力情報",
} as const;

export const MODE_LABEL: Record<string, string> = { single: "単一商品", all: "B 商品ごとに当落", one_win: "C 当選は1商品まで", choose_one: "D 希望の1つを選んで応募" };
export const APPLY_METHOD_LABELS: Record<string, string> = { web: "Web", store: "店頭", app: "アプリ", unknown: "不明" };
export const RECEIVE_LABELS: Record<string, string> = { store: "店頭受取", shipping: "発送", either: "店頭・発送から選択", unknown: "不明" };
export const EVENT_LABELS: Record<string, string> = { before: "受付前", open: "受付中", closed: "受付終了", cancelled: "中止", postponed: "延期" };
export const LIMIT_BASIS_LABELS: Record<string, string> = { unknown: "未確認", account: "アカウント", person: "人", family: "家族", address: "住所" };
export const UNIT_LABELS: Record<string, string> = { box: "BOX", pack: "パック", set: "セット" };
export const APPLY_STATUS_LABELS: Record<string, string> = { applied: "応募済み", cancelled: "取消", none: "未応募" };
export const RESULT_LABELS: Record<string, string> = { pending: "未確認", won: "当選", lost: "落選", unknown: "不明" };
export const FULFILLMENT_LABELS: Record<string, string> = { none: "なし", procedure_done: "手続き済み", purchased: "購入済み" };
export const LOGIC_LABELS: Record<string, string> = { and: "すべて必要", or: "いずれか" };
export const TARGET_LABELS: Record<string, string> = Object.fromEntries(ANNOUNCE_TARGETS.map((t) => [t.code, t.label]));
export const MANAGED_LABELS: Record<string, string> = { true: "○", false: "×" };
export const SKIP_LABELS: Record<string, string> = { true: "スルー", false: "解除" };

const L = (key: string, label: string, note: string, width = 14, extra: Partial<ColumnDef> = {}): ColumnDef => ({ key, label, note, width, clearable: false, ...extra });

export const LOTTERY_COLUMNS: readonly ColumnDef[] = [
  L("lottery_id", "抽選ID", "既存の抽選はこのIDで特定します（変更しない）。新規の行は空欄にして「取込キー」を入れてください", 38),
  L("import_key", "取込キー", "新規の行だけ。「対象商品」「応募・当落履歴」シートの同じ取込キーと結び付けます（例: NEW001）。DB内部のIDとは別です", 12),
  L("chain_id", "系列ID", "既存の系列のID。空欄なら系列名で照合します", 38),
  L("chain", "系列名", "未登録の系列は、取り込みの確認画面で「既存候補を選ぶ／新規登録／保留」を選びます", 18),
  L("store_no", "店舗ID", "店舗の管理番号（ST000001）。空欄なら店舗名で照合します", 12),
  L("store", "店舗名", "未登録の店舗は、確認画面で選びます。住所・都道府県は推測しません", 22),
  L("apply_start", "応募開始日", "YYYY-MM-DD。過去の日付も可。日付が不明なら空欄", 12, { clearable: true }),
  L("apply_start_time", "応募開始時刻", "HH:MM。時刻が不明なら空欄（時刻は補いません）", 10, { clearable: true }),
  L("apply_deadline", "応募締切日", "YYYY-MM-DD", 12, { clearable: true }),
  L("apply_deadline_time", "応募締切時刻", "HH:MM。不明なら空欄", 10, { clearable: true }),
  L("result_start", "発表開始日", "当落発表の日（期間のときは開始日）", 12, { clearable: true }),
  L("result_start_time", "発表開始時刻", "HH:MM。不明なら空欄", 10, { clearable: true }),
  L("result_end", "発表終了日", "期間のときだけ。開始日以降の日付", 12, { clearable: true }),
  L("announce_methods", "発表方法", `標準の選択肢から1つ（${ANNOUNCE_METHODS.map((m) => m.label).join("／")}）。ほかの確認方法は補足へ`, 26, { clearable: true }),
  L("announce_target", "通知対象", `${ANNOUNCE_TARGETS.map((t) => t.label).join("／")}。経路とは別に指定します`, 14),
  L("announce_note", "発表方法の補足", "短い補足・原文（200文字まで）", 28, { clearable: true }),
  L("announce_url", "結果確認URL", "http(s):// で始まるURL", 28, { clearable: true }),
  L("apply_method", "応募方法", "Web / 店頭 / アプリ / 不明", 10),
  L("req_tags", "応募条件", `標準の選択肢（${REQUIREMENT_TAGS.map((t) => t.label).join("／")}）。複数は ${LIST_SEPARATOR} で区切る`, 30, { clearable: true }),
  L("req_logic", "条件の結合", "すべて必要 / いずれか（複数条件のとき）", 12),
  L("req_note", "応募条件の補足", "構造化できない条件・原文（2000文字まで）", 30, { clearable: true }),
  L("req_amount", "購入金額(円以上)", "整数。不明なら空欄（推測しません）", 12, { clearable: true }),
  L("req_period_from", "購入対象期間(開始)", "YYYY-MM-DD", 12, { clearable: true }),
  L("req_period_to", "購入対象期間(終了)", "YYYY-MM-DD", 12, { clearable: true }),
  L("req_rank", "会員ランク", "40文字まで", 12, { clearable: true }),
  L("req_age", "年齢(歳以上)", "整数", 10, { clearable: true }),
  L("req_area", "居住地域", "60文字まで", 14, { clearable: true }),
  L("req_max_stores", "応募可能店舗数", "整数", 10, { clearable: true }),
  L("verification", "本人確認・書類", "1000文字まで", 24, { clearable: true }),
  L("limit_basis", "応募制限の単位", "未確認 / アカウント / 人 / 家族 / 住所", 12),
  L("limit_max", "応募制限の回数", "1〜99", 10),
  L("receive_method", "受取方法", "店頭受取 / 発送 / 店頭・発送から選択 / 不明", 18),
  L("procedure_start", "購入・受取開始日", "YYYY-MM-DD", 12, { clearable: true }),
  L("procedure_start_time", "購入・受取開始時刻", "HH:MM。不明なら空欄", 10, { clearable: true }),
  L("procedure_end", "購入・受取終了日", "YYYY-MM-DD", 12, { clearable: true }),
  L("procedure_end_time", "購入・受取終了時刻", "HH:MM。不明なら空欄", 10, { clearable: true }),
  L("multi_mode", "抽選方式", "単一商品 / B 商品ごとに当落 / C 当選は1商品まで / D 希望の1つを選んで応募。取り込みで勝手に変わりません", 22),
  L("event_state", "抽選ステータス", "受付前 / 受付中 / 中止 / 延期（受付終了は期限から自動で判定されるため、指定できません）", 12),
  L("managed", "管理対象", "○ = ★管理対象 / × = 管理対象外", 10),
  L("memo", "備考", "2000文字まで", 28, { clearable: true }),
  L("source_urls", "情報源URL", `複数は ${LIST_SEPARATOR} で区切る（10件まで）`, 36, { clearable: true }),
];

export const ITEM_COLUMNS: readonly ColumnDef[] = [
  L("lottery_id", "抽選ID", "既存の抽選のID。新規の抽選は空欄にして取込キーを入れる", 38),
  L("import_key", "取込キー", "新規の抽選の取込キー", 12),
  L("item_id", "商品明細ID", "既存の明細のID。空欄なら新しい明細として追加します（ここに無い既存の明細は削除しません）", 38),
  L("product_no", "商品ID", "商品の管理番号（PR000001）。空欄なら正式商品名で照合します", 12),
  L("product", "正式商品名", "未登録の商品は、確認画面で選びます", 34),
  L("quantity", "数量", "1〜9999", 8),
  L("unit", "数量単位", "BOX / パック / セット", 10),
];

export const APP_COLUMNS: readonly ColumnDef[] = [
  L("lottery_id", "抽選ID", "既存の抽選のID。新規の抽選は空欄にして取込キーを入れる", 38),
  L("import_key", "取込キー", "新規の抽選の取込キー", 12),
  L("application_id", "応募記録ID", "既存の応募記録のID（確認用。空欄でもプロフィールで特定します）", 38),
  L("profile_id", "プロフィールID", "プロフィールのID。空欄ならプロフィール名で照合します", 38),
  L("profile", "プロフィール名", "", 14),
  L("item_id", "対象商品明細ID", "商品別の当落・希望商品の指定に使います（単一商品の抽選では空欄）", 38),
  L("item_product", "対象商品", "明細IDが無いとき、商品の管理番号か正式商品名で指定します", 24),
  L("apply_status", "応募状況", "応募済み / 取消 / 未応募。行が無い＝記録が無い、とは別です。「未応募」は既存の応募を戻す指定にはなりません", 12),
  L("applied_on", "応募日", "YYYY-MM-DD。過去の日付も可", 12, { clearable: true }),
  L("applied_time", "応募時刻", "HH:MM。空欄なら 0:00（日本時間）で記録します", 10, { clearable: true }),
  L("result", "当落結果", "未確認 / 当選 / 落選 / 不明", 10),
  L("confirmed_on", "当落確認日", "YYYY-MM-DD。空欄なら変更しません", 12, { clearable: true }),
  L("fulfillment", "購入手続き状況", "なし / 手続き済み。「購入済み」は購入記録を作る操作で行うため、取り込みでは設定できません（出力のみ）", 14),
  L("skip", "スルー設定", "スルー = この抽選をスルー / 解除 = スルーを外す。空欄なら変更しません", 10),
];

export type LotteryKey = (typeof LOTTERY_COLUMNS)[number]["key"];

/** 行の結果の種類 */
export type LStatus = "new" | "update" | "unchanged" | "duplicate" | "review" | "error";

export interface LIssue {
  sheet: string;
  row: number;
  column: string;
  message: string;
}
export interface LChange {
  column: string;
  before: string;
  after: string;
}

/** 利用者が確認画面で選ぶ項目（未登録マスター・重複候補） */
export interface Decision {
  /** 例: m:product:<名前キー> / m:store:<系列キー>|<名前キー> / m:chain:<名前キー> / d:<行キー> */
  key: string;
  kind: "chain" | "store" | "product" | "duplicate";
  /** 表示名 */
  name: string;
  /** 該当する行（シート・行番号） */
  rows: string[];
  /** 選択肢 */
  options: { value: string; label: string }[];
  /** 現在の選択（未選択は null＝保留扱いで適用されない） */
  chosen: string | null;
}

export interface LPreviewRow {
  sheet: string;
  row: number;
  /** 一覧で見分ける名前 */
  label: string;
  /** 抽選ID（新規は空） */
  id: string | null;
  status: LStatus;
  changes: LChange[];
  errors: LIssue[];
  notes: string[];
  /** 応募・当落の件数（この抽選の応募記録の行数） */
  applications: number;
}

export interface LPreviewCounts {
  new: number;
  update: number;
  unchanged: number;
  duplicate: number;
  review: number;
  error: number;
}

export interface LPreviewResult {
  counts: LPreviewCounts;
  rows: LPreviewRow[];
  decisions: Decision[];
  /** 子シート（対象商品・応募履歴）の行数 */
  childRows: { items: number; apps: number };
  /** エラーが無く、適用する行がある */
  applicable: boolean;
  fingerprint: string;
}

/** 重複候補・未登録マスターを確認画面で選んだ結果（キー → 値） */
export type Decisions = Record<string, string>;

export interface LGrid {
  sheet: string;
  columns: Record<string, number>;
  rows: { row: number; cells: Record<string, string> }[];
}
