/**
 * 抽選管理に必要な全項目の定義（Phase 3 INTENSIVE_EVALUATION §3）。AIの判断の出力（fields のキー）・検証・保存・画面・正解の記録・採点で同じ名前を使う。
 * 実アプリの抽選（lotteries）の列に対応させる（括弧内）。新しい列は足さず、表現できない情報（受取場所・発表方法など）は既存の文字列の列（announcement_method・memo・conditions_text）へ写せる形にする。
 *  - 日付の値は「YYYY-MM-DD」（日付だけ）か「YYYY-MM-DD HH:mm」（時刻あり）。原文に年が無いときは、評価時点に最も近い年で補ってよいが、引用は原文のまま。
 *  - 期間は開始・終了を別の項目にする（応募・発表・購入・受取を混同しない）。
 *  - 値が無い項目は、記載の状態（absence）で区別する: not_stated（全文を読んだが記載なし）／not_announced（「後日発表」「未定」と書かれている）／anytime（随時・期限なし）／unreadable（取得できない・読めない範囲がある）。勝手に補完しない。
 * 個別の店舗・系列の規則はここに書かない（汎用の定義だけ）。
 */
export type FieldKind = "text" | "date" | "number" | "enum";
export interface LotteryFieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  /** 本登録の可否を左右する項目（検証の失敗が本登録を止める）。それ以外は任意項目（失敗はその項目だけ不採用） */
  critical?: boolean;
  /** 列挙の値（enum のとき） */
  values?: readonly string[];
  /** 実アプリの抽選の列（参考） */
  column: string;
}

export const LOTTERY_FIELDS: readonly LotteryFieldDef[] = [
  { key: "store", label: "店舗", kind: "text", critical: true, column: "chain/store（複数・選択式は selectable_stores）" },
  { key: "store_location", label: "所在地", kind: "text", column: "stores.prefecture" },
  { key: "product", label: "商品", kind: "text", critical: true, column: "lottery_items.product" },
  { key: "price", label: "価格", kind: "number", column: "memo" },
  { key: "apply_start", label: "応募開始", kind: "date", column: "apply_start_*" },
  { key: "deadline", label: "応募締切", kind: "date", critical: true, column: "apply_deadline_*" },
  { key: "result_at", label: "当選発表", kind: "date", column: "result_*" },
  { key: "result_end", label: "発表の終わり", kind: "date", column: "result_end_date" },
  { key: "result_method", label: "発表方法", kind: "text", column: "announcement_method" },
  { key: "purchase_start", label: "購入開始", kind: "date", column: "procedure_start_*" },
  { key: "purchase_end", label: "購入期限", kind: "date", column: "procedure_deadline_*" },
  { key: "receive_start", label: "受取開始", kind: "date", column: "receive_start_*" },
  { key: "receive_end", label: "受取期限", kind: "date", column: "receive_deadline_*" },
  { key: "receive_method", label: "受取方法", kind: "enum", values: ["store", "shipping", "either"], column: "receive_method" },
  { key: "receive_place", label: "受取場所", kind: "text", column: "memo" },
  { key: "apply_url", label: "応募先URL", kind: "text", column: "source_urls" },
  { key: "apply_method", label: "応募方法", kind: "text", column: "apply_method（web/store/app）・conditions_text" },
  { key: "conditions", label: "応募条件", kind: "text", column: "conditions_text" },
  { key: "apply_unit", label: "応募単位", kind: "enum", critical: true, values: ["one_form_one", "store_select", "per_store", "per_product"], column: "store_mode" },
  { key: "per_person_limit", label: "口数", kind: "number", column: "limit_max_count" },
];
/** 判断・検証のための内部項目（画面の抽選項目ではない） */
export const INTERNAL_FIELDS = ["exclude_reason", "fit_region"] as const;
export const FIELD_KEYS: readonly string[] = LOTTERY_FIELDS.map((f) => f.key);
export const DATE_FIELDS: ReadonlySet<string> = new Set(LOTTERY_FIELDS.filter((f) => f.kind === "date").map((f) => f.key));
export const FIELD_LABELS: Record<string, string> = Object.fromEntries([...LOTTERY_FIELDS.map((f) => [f.key, f.label]), ["exclude_reason", "除外の理由"], ["fit_region", "地域の適合"]]);
export const ABSENCE = ["not_stated", "not_announced", "anytime", "unreadable"] as const;
export type Absence = (typeof ABSENCE)[number];
export const ABSENCE_LABELS: Record<Absence, string> = { not_stated: "記載なし", not_announced: "未発表", anytime: "随時・期限なし", unreadable: "取得・確認できない" };

/** 判断の担当への指示に埋め込む項目の一覧（キー・意味・形式）。プロンプトの生成にだけ使う */
export function fieldGuide(): string {
  return LOTTERY_FIELDS.map((f) => `${f.key}（${f.label}${f.kind === "date" ? "・YYYY-MM-DD か YYYY-MM-DD HH:mm" : f.kind === "enum" ? `・${(f.values ?? []).join("/")}` : f.kind === "number" ? "・数字" : ""}）`).join("／");
}
