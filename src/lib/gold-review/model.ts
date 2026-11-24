/**
 * 独立gold確認（開発専用レビュー画面）のモデルと検査（純関数・クライアントからも使える）。
 *
 * 守ること:
 *  - 機械抽出した候補は**未確認**。人が公式ページと照らして**項目ごとに**確認（チェック）し、根拠の引用がページの本文に実在し、確認の基準を書いたときだけ「確認済み」にできる。
 *    一括承認はできない（5項目それぞれの確認が要る）。AI・旧方式・登録案・モックの出力は gold に使わない（確認の基準にその旨の語があれば拒否）。
 *  - 確認したページの版（HTMLのハッシュ）を残す。あとでページが変わったら「要再確認」に戻る。履歴（誰が・いつ・何を）を残す。
 *  - 1ページ=1応募機会に合わないページ（複数の受付枠・商品・店舗）は、理由つきで「除外」にして残す（別の試験＝複数機会の試験の対象にできる）。
 */
export type ReviewStatus = "unreviewed" | "confirmed" | "excluded" | "needs_recheck";
export type ApplyUnit = "one_form_one" | "store_select" | "per_store" | "per_product";
export const APPLY_UNITS: { value: ApplyUnit; label: string }[] = [
  { value: "one_form_one", label: "応募の機会が1つ（受付枠・フォームが1つ）" },
  { value: "store_select", label: "1回の申込で店舗を選ぶ（1店舗のみ）" },
  { value: "per_store", label: "店舗ごとに独立した応募" },
  { value: "per_product", label: "商品ごとに独立した応募" },
];
export type ExcludeReason = "multi_slot" | "multi_product" | "multi_store" | "not_apply_page" | "unclear" | "other";
export const EXCLUDE_REASONS: { value: ExcludeReason; label: string; suitableForMultiOpportunity: boolean }[] = [
  { value: "multi_slot", label: "受付枠が複数ある（応募機会が複数）", suitableForMultiOpportunity: true },
  { value: "multi_product", label: "商品が複数ある", suitableForMultiOpportunity: true },
  { value: "multi_store", label: "店舗が複数ある", suitableForMultiOpportunity: true },
  { value: "not_apply_page", label: "応募のページではない", suitableForMultiOpportunity: false },
  { value: "unclear", label: "公式ページを見ても判断できない", suitableForMultiOpportunity: false },
  { value: "other", label: "その他（メモに理由）", suitableForMultiOpportunity: false },
];

export interface Draft {
  store: string;
  product: string;
  /** YYYY-MM-DD。ページに締切が無い・確認できないときは null（その場合 applyEndUnknown を明示する） */
  applyEnd: string | null;
  applyEndUnknown: boolean;
  applyUnit: ApplyUnit | null;
  applyUnitUnknown: boolean;
  region: string;
  /** 開催回・受付枠のメモ（例: 第2回／チケットA）。応募機会の取り違え防止の記録 */
  round: string;
  /** 根拠の原文の引用（ページの本文にある一字一句） */
  quotes: string[];
  /** 同じ応募機会を別のページ（番号）が重ねて書いている場合の、最初のページの番号。**同じ企画・同一の応募機会を2機会と数えない**ための印（人が判断する） */
  sameOpportunityAs: number | null;
}
export const emptyDraft = (): Draft => ({ store: "", product: "", applyEnd: null, applyEndUnknown: false, applyUnit: null, applyUnitUnknown: false, region: "", round: "", quotes: [], sameOpportunityAs: null });

/** 項目ごとの確認（全て true でないと確認済みにできない） */
export interface FieldChecks {
  officialPageOpened: boolean;
  store: boolean;
  product: boolean;
  applyEnd: boolean;
  applyUnit: boolean;
  quotes: boolean;
}
export const emptyChecks = (): FieldChecks => ({ officialPageOpened: false, store: false, product: false, applyEnd: false, applyUnit: false, quotes: false });

export interface PageVersion {
  /** 取得して保存したHTMLのハッシュ（先頭16桁） */
  hash: string;
  chars: number;
  /** 保存した日時（ファイルの更新日時） */
  savedAt: string;
}

export interface HistoryEntry {
  at: string;
  action: "draft_saved" | "confirmed" | "excluded" | "reopened" | "imported" | "page_changed" | "held";
  /** 変更した項目名だけ（値は履歴に重ねて持たない。確認済みの値は confirmed に残る） */
  changed?: string[];
  note?: string;
}

export interface Confirmed {
  draft: Draft;
  checks: FieldChecks;
  basis: string;
  verifiedAt: string;
  pageVersion: PageVersion;
  /** 確認した人（利用者IDのハッシュ。個人情報は残さない） */
  reviewer: string;
}

export interface PageRecord {
  n: number;
  status: ReviewStatus;
  draft: Draft;
  checks: FieldChecks;
  confirmed?: Confirmed;
  excluded?: { reason: ExcludeReason; note: string; at: string; pageVersion: PageVersion };
  history: HistoryEntry[];
}

export interface ReviewState {
  v: 1;
  updatedAt: string;
  pages: PageRecord[];
}

const FORBIDDEN_BASIS = /(ai[-_ ]?output|model[-_ ]?output|mock|replay|old[-_ ]?system|legacy|proposal|registration_proposals|AIの出力|旧方式|登録案|モック)/i;
const nfkc = (s: string): string => s.normalize("NFKC").replace(/\s+/g, "");

export type Problem = { field: string; message: string };

/** 確認済みにするための検査。ページの本文（pageText）との照合を含む。問題が1つでもあれば確認済みにしない */
export function validateConfirm(a: { draft: Draft; checks: FieldChecks; basis: string; pageText: string }): Problem[] {
  const p: Problem[] = [];
  const d = a.draft;
  if (!a.checks.officialPageOpened) p.push({ field: "officialPageOpened", message: "公式ページを開いて確認したことにチェックしてください" });
  if (!d.store.trim()) p.push({ field: "store", message: "店舗を入力してください" });
  if (!d.product.trim()) p.push({ field: "product", message: "商品を入力してください" });
  if (d.applyEnd !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d.applyEnd)) p.push({ field: "applyEnd", message: "応募締切は YYYY-MM-DD で入力してください" });
  if (d.applyEnd === null && !d.applyEndUnknown) p.push({ field: "applyEnd", message: "応募締切を入力するか、「ページに締切が無い／確認できない」を明示してください" });
  if (d.applyUnit === null && !d.applyUnitUnknown) p.push({ field: "applyUnit", message: "応募単位を選ぶか、「確認できない」を明示してください" });
  for (const k of ["store", "product", "applyEnd", "applyUnit", "quotes"] as const) if (!a.checks[k]) p.push({ field: `check_${k}`, message: `「${{ store: "店舗", product: "商品", applyEnd: "応募締切", applyUnit: "応募単位", quotes: "根拠の引用" }[k]}」の確認にチェックしてください（項目ごとに確認が必要です）` });
  const quotes = d.quotes.map((q) => q.trim()).filter(Boolean);
  if (quotes.length === 0) p.push({ field: "quotes", message: "根拠の引用を1つ以上入力してください" });
  const hay = nfkc(a.pageText);
  for (const q of quotes) {
    if (nfkc(q).length < 6) p.push({ field: "quotes", message: `引用が短すぎます（6字以上）:「${q.slice(0, 20)}」` });
    else if (!hay.includes(nfkc(q))) p.push({ field: "quotes", message: `引用がページの本文に見つかりません:「${q.slice(0, 24)}…」` });
  }
  const basis = a.basis.trim();
  if (basis.length < 5) p.push({ field: "basis", message: "確認の基準（何をどう確認したか）を5字以上で書いてください" });
  else if (FORBIDDEN_BASIS.test(basis)) p.push({ field: "basis", message: "確認の基準に、AI・旧方式・登録案・モックの出力に頼ったことを示す語があります（独立した人の確認だけを正解にします）" });
  // 店舗・締切が、引用にもページ本文にも現れない（取り違えの疑い）
  if (d.store.trim() && !hay.includes(nfkc(d.store.trim()).slice(0, 6))) p.push({ field: "store", message: "店舗名がページの本文に見つかりません（表記の違いなら、本文にある表記で入力してください）" });
  return p;
}

export function progressOf(pages: readonly PageRecord[]): Record<ReviewStatus, number> & { total: number; complete: boolean } {
  const c = { unreviewed: 0, confirmed: 0, excluded: 0, needs_recheck: 0 } as Record<ReviewStatus, number>;
  for (const x of pages) c[x.status]++;
  return { ...c, total: pages.length, complete: pages.length > 0 && c.unreviewed === 0 && c.needs_recheck === 0 && c.confirmed > 0 };
}

export const nowIso = (): string => new Date().toISOString();
