/**
 * 抽選情報の共通モデル「案件ファイル」（Stage 9H-3B・純粋な型と補助関数。サーバー・AIの部品を import しない）。
 * 通常の収集（AI抽出 → 固定ロジックの連鎖 → 登録候補）と、調査エージェント（情報源の探索・照合・統合）が、同じ構造で
 * 「どの項目を・誰が・どの根拠で・どの確度で」決めたかを持つ。登録候補への変換は既存の抽出形式（ExtractedLottery）を経由し、
 * 既存の登録経路（buildDraft → 登録判定）を二重に作らない。
 *
 * 方針:
 *  - 値は文字列。日時は "YYYY-MM-DD" または "YYYY-MM-DD HH:MM"、複数の値（商品・選べる店舗）は " / " 区切り。
 *  - 確定(confirmed)は固定ロジックが根拠（一次情報・独立した複数の出どころ）で与える。AIの読み取りだけでは「推定」止まり。
 *  - 登録候補の形に対応する欄が無い情報は、黙って捨てずに unreflected に残す。
 *  - 変更・破棄・保留の履歴（decisions）を必ず残す。
 */

export type CaseFieldKey =
  | "chain"
  | "store"
  /** 抽選形態: store_select=店舗選択式 / store_independent=店舗別独立 / other=その他 */
  | "form"
  | "selectableStores"
  | "items"
  | "applyStart"
  | "applyDeadline"
  /** 当選発表の開始（単一の発表日もここ） */
  | "resultStart"
  /** 当選発表の終了（期間のときだけ） */
  | "resultEnd"
  | "applyMethod"
  | "conditions"
  | "applyUrl"
  | "receiveMethod";

export const CASE_FIELD_KEYS: CaseFieldKey[] = ["chain", "store", "form", "selectableStores", "items", "applyStart", "applyDeadline", "resultStart", "resultEnd", "applyMethod", "conditions", "applyUrl", "receiveMethod"];

export const CASE_FIELD_LABEL: Record<CaseFieldKey, string> = {
  chain: "系列",
  store: "店舗",
  form: "抽選形態",
  selectableStores: "選べる店舗",
  items: "商品",
  applyStart: "応募開始",
  applyDeadline: "応募締切",
  resultStart: "当選発表（開始）",
  resultEnd: "当選発表（終了）",
  applyMethod: "応募方法",
  conditions: "応募条件",
  applyUrl: "応募URL",
  receiveMethod: "受取方法",
};

/** confirmed=確定（根拠あり）/ inferred=推定（AIが情報源から読み取った。確定ではない）/ unverified=未確認（根拠が弱い）/ conflict=矛盾 / missing=不明 / manual=人間が確定 */
export type CaseFieldState = "confirmed" | "inferred" | "unverified" | "conflict" | "missing" | "manual";
/** 値を決めた主体 */
export type Actor = "ai" | "fixed" | "master" | "human" | "seed" | "investigation";

export interface EvidenceRef {
  url?: string;
  /** 原文の短い抜粋 */
  quote?: string;
  /** 情報源の種類（organizer_official など。自由文字列） */
  kind?: string;
  tier?: "primary" | "secondary";
  /** 応募サービスのページで、主催者の本文か、サービス側の受付表示か */
  basis?: "organizer_body" | "platform_meta";
  at?: string;
  origin?: string;
}

export interface CaseField {
  value: string | null;
  state: CaseFieldState;
  by: Actor;
  evidence: EvidenceRef[];
  alternatives: { value: string; evidence: EvidenceRef[] }[];
  note?: string;
}

export interface CaseSource {
  url: string;
  kind: string;
  tier: "primary" | "secondary";
  status: "used" | "failed" | "not_same" | "unreported" | "registered";
  fetchedAt?: string;
  /** 告知日時・更新日時 */
  publishedAt?: string;
  note?: string;
}

export type DecisionStage = "input" | "ai" | "validate" | "fixed" | "merge" | "investigation" | "final";
export type DecisionKind = "adopted" | "changed" | "dropped" | "held" | "rejected" | "noted";
export interface DecisionRecord {
  stage: DecisionStage;
  field: CaseFieldKey | "general" | "duplicate" | "decision";
  kind: DecisionKind;
  before: string | null;
  after: string | null;
  by: Actor;
  reason: string;
}

/** 登録候補の形に対応する欄が無く、反映できなかった情報（黙って捨てない） */
export interface UnreflectedInfo {
  key: string;
  value: string;
  reason: string;
  evidence?: EvidenceRef[];
}

export interface CaseFile {
  version: 1;
  id: string;
  createdAt: string;
  sources: CaseSource[];
  fields: Record<CaseFieldKey, CaseField>;
  /** 人間が確定した項目（自動で上書きしない） */
  humanLocked: CaseFieldKey[];
  unreflected: UnreflectedInfo[];
  decisions: DecisionRecord[];
}

export const emptyField = (): CaseField => ({ value: null, state: "missing", by: "seed", evidence: [], alternatives: [] });

export function emptyCase(id: string, createdAt: string): CaseFile {
  const fields = {} as Record<CaseFieldKey, CaseField>;
  for (const k of CASE_FIELD_KEYS) fields[k] = emptyField();
  return { version: 1, id, createdAt, sources: [], fields, humanLocked: [], unreflected: [], decisions: [] };
}

/** 判断の履歴は最大件数で打ち切る（保存容量。古いものから落とす） */
export const MAX_DECISIONS = 60;
export function addDecision(c: CaseFile, d: DecisionRecord): void {
  const last = c.decisions[c.decisions.length - 1];
  if (last && last.stage === d.stage && last.field === d.field && last.kind === d.kind && last.after === d.after && last.reason === d.reason) return;
  c.decisions.push(d);
  if (c.decisions.length > MAX_DECISIONS) c.decisions.splice(0, c.decisions.length - MAX_DECISIONS);
}

export const isSet = (f: CaseField): boolean => f.value !== null && f.value !== "" && f.state !== "missing";
export const splitList = (v: string | null): string[] => (v ? v.split(" / ").map((s) => s.trim()).filter(Boolean) : []);
