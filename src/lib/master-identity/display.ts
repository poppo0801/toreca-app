/**
 * 表示名（Stage 9H-3S・純関数）。正式名称・別名・略称の役割:
 *   正式名称: マスターの基準となる名称（詳細・編集・購入履歴など）
 *   別名: 同一性の判定・検索・AI学習に使う名称（表示には使わない）
 *   略称: 利用者が設定する表示専用の名称（抽選一覧など表示領域の限られた画面で優先して表示する。AIは自動で変更しない）
 *
 * 既存データの移行: 以前は「別名の先頭」を略称として表示していた画面がある。略称を分離しても表示が変わらないよう、略称が未設定の商品に限り、
 * 従来の別名（由来 legacy＝本機能の導入前に登録された別名）の先頭を、一覧の表示名として使う。AIが学習した別名は表示に使わない。
 */
export interface DisplayNameInput {
  officialName: string;
  /** 利用者が設定した略称 */
  shortName?: string | null;
  /** 導入前から登録されていた別名（由来 legacy）。略称が未設定のときだけ表示に使う（利用者が略称へ変更すれば、そちらが優先） */
  legacyAliases?: string[];
}

const clean = (s: string | null | undefined) => (s ?? "").trim();

/** 抽選一覧など、表示領域の限られた画面の表示名 */
export function compactName(p: DisplayNameInput): string {
  return clean(p.shortName) || clean(p.legacyAliases?.[0]) || p.officialName;
}

/** 詳細・編集・購入履歴など、正式名称が必要な画面の表示名（従来どおり） */
export function fullName(p: Pick<DisplayNameInput, "officialName">): string {
  return p.officialName;
}

/** 略称が設定されているか（編集画面の注意表示用） */
export const hasShortName = (p: Pick<DisplayNameInput, "shortName">): boolean => clean(p.shortName) !== "";
