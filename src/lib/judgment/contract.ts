/**
 * 統合AI判断の入出力契約（Stage 10E・版つき）。`docs/AI_REDESIGN_SPEC.md` §3。
 *
 * 考え方:
 *  - AIが意味判断の主体。入力は「実際に取得した原文」と関連情報、出力は「構造・値・関係・未解決・次の行動」と、それぞれの根拠。
 *  - **観測事実（fact）・推論（inference）・不明（unknown）を区別**する。fact には、入力の原文に実在する引用（evidenceId＋quote）が必須。
 *  - **AIの自己申告の確信度の項目は契約に無い**（出力に含まれていても検証層が捨てる）。確定は根拠の検証で決める。
 *  - 応募機会（Opportunity）は、応募・当落が独立しているかで決める。フォーム数・店舗数・URL数と同一視しない。
 *  - 外部の文面（原文）はデータ。命令として実行しない（出力の次の行動は、決まった種類だけ）。
 */
/**
 * 契約の版。10e.2 = 10e.1 に構造の種類 `per_round`（開催回別の独立）を加えたもの（加算のみ）。
 * 出力の検査は 10e.1 も受け付ける（10e.1 の出力は 10e.2 の部分集合）。判断履歴（case_judgments）には契約の版を列として持たず、構造は文字列として保存されるため、過去の履歴は再解釈・書き換えなしにそのまま読める。
 */
export const CONTRACT_VERSION = "10e.2";
export const ACCEPTED_OUTPUT_VERSIONS: readonly string[] = ["10e.1", "10e.2"];

export type Basis = "fact" | "inference" | "unknown";
export type EvidenceStatus = "fetched" | "fetched_unread" | "unfetchable" | "not_fetched";

// ---------------------------------------------------------------- 入力
export interface EvidenceItem {
  /** この判断の中での参照ID（E1, E2…） */
  id: string;
  url: string;
  fetchedAt: string | null;
  via: string;
  origin: "primary" | "secondary" | "unknown";
  /** 取得状況。fetched 以外は本文なし（本文が無いものを、AIが推測で埋めない） */
  status: EvidenceStatus;
  /** 取得した原文（伏せ字済み・切り詰め済み）。status が fetched のときだけ */
  text: string | null;
  hash: string | null;
  /** 保存済みの原文の再利用か（9Z） */
  reused?: boolean;
  /** 以前の解析では読み取れなかった原文（本文は読める。読み落としの再判断） */
  priorReadFailed?: boolean;
}

export interface RelatedOpportunity {
  lotteryId: string;
  chain: string | null;
  store: string | null;
  products: string[];
  applyDeadline: string | null;
  /** 現在の登録上の構造（店舗選択式・固定店舗など）。事実として確認済みかは別 */
  storeMode: "fixed" | "select_on_apply" | "none" | null;
  /** 履歴保護の理由コード（DB関数 lottery_history_blockers）。空なら記録上の保護なし */
  protectedCodes: string[];
  /** 保護の確認ができなかった（DB参照の失敗など）。true のときは「保護なし」とみなさず、検証層が自律的な変更を拒否する（安全側） */
  protectionUnknown?: boolean;
  /** 人が確定した値（項目名→値）。AIは上書きできない */
  humanConfirmed?: Record<string, string>;
}

/**
 * この判断の対象となる案件**自身**の既存の登録内容（Stage 10H）。別の抽選（related）ではない。識別子・保護情報・世帯情報を含めない。
 * 目的: 「対象自身の登録と同じか」という自己照合の疑問を生ませず、原文と登録内容の**値の食い違い**だけを見られるようにする。
 */
export interface CurrentCase {
  chain: string | null;
  store: string | null;
  products: string[];
  applyStart: string | null;
  applyDeadline: string | null;
  resultDate: string | null;
  storeMode: "fixed" | "select_on_apply" | "none" | null;
}

export interface MasterCandidate {
  kind: "chain" | "store" | "product";
  /** マスターの正式名 */
  name: string;
  aliases: string[];
  /** 候補になった理由（固定の正規化は候補検索の補助。同一かどうかの結論ではない） */
  matchedBy: string[];
}

export interface PriorJudgment {
  id: string;
  kind: string;
  subject: string;
  claimBasis: Basis;
  value: string;
  judgeKind: "ai" | "fixed" | "human";
  correctionOf: string | null;
  at: string;
}

export interface FailureRecord {
  url: string;
  kind: "unfetchable" | "not_found" | "no_new_info" | "read_failed";
  at: string;
}

export interface JudgmentInput {
  version: typeof CONTRACT_VERSION;
  caseId: string | null;
  title: string;
  /** 判断の基準日（締切の過不足の判断・時点の比較に使う） */
  now: string;
  evidence: EvidenceItem[];
  related: RelatedOpportunity[];
  /** 対象案件自身の既存の登録内容（あれば）。related とは別物 */
  currentCase?: CurrentCase;
  masters: MasterCandidate[];
  /** 人の修正を先頭に、新しい順（過去のAI判断は正解ではない。参考） */
  priorJudgments: PriorJudgment[];
  failures: FailureRecord[];
  /** 対象地域（都道府県）。空なら制限なし */
  regionPrefectures: string[];
  /** 再判断のとき、前回の検証で不合格だった理由（具体的に直すため） */
  feedback?: string[];
}

// ---------------------------------------------------------------- 出力
export interface Citation {
  evidenceId: string;
  /** 原文からの引用（原文に実在すること。検証層が照合する） */
  quote: string;
}

export interface Claim<T = string> {
  value: T;
  basis: Basis;
  citations: Citation[];
}

export type StructureKind = "one_form_one" | "store_select" | "per_store" | "per_product" | "per_round" | "multi_independent_per_submit" | "unknown";
export type CaseType = "lottery_announcement" | "result_announcement" | "update" | "not_lottery" | "unknown";
export type RelationKind = "same" | "independent" | "same_campaign_other" | "unknown";
export type PlannedOp = "link_case" | "fill_empty" | "change" | "merge" | "delete" | "move_history";

export interface OpportunityOut {
  /** この出力内のキー（O1, O2…） */
  key: string;
  label: string;
  chain?: Claim;
  store?: Claim;
  products?: Claim<string[]>;
  applyStart?: Claim;
  applyDeadline?: Claim;
  resultDate?: Claim;
  conditions?: Claim;
}

export interface UnresolvedItem {
  id: string;
  question: string;
  importance: "high" | "medium" | "low";
  /** 次に見るとよい情報源の手がかり */
  hintUrl?: string;
}

export type NextAction =
  | { kind: "fetch_url"; target: string; reason: string }
  | { kind: "search"; target: string; reason: string }
  | { kind: "ask_human"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "none"; reason: string };

export interface JudgmentOutput {
  version: typeof CONTRACT_VERSION;
  caseType: Claim<CaseType>;
  structure: {
    kind: StructureKind;
    basis: Basis;
    selectableStores?: string[];
    rationale: string;
    citations: Citation[];
  };
  opportunities: OpportunityOut[];
  relations: { opportunityKey: string; lotteryId: string; relation: RelationKind; basis: Basis; citations: Citation[]; rationale: string }[];
  /** 既存の抽選への変更の提案（実行はしない。検証層が履歴保護を確認する） */
  plannedChanges: { lotteryId: string; op: PlannedOp; field?: string; value?: string; reason: string }[];
  unresolved: UnresolvedItem[];
  nextActions: NextAction[];
}

// ---------------------------------------------------------------- 形式の検査（意味の判断はしない）
const BASES = ["fact", "inference", "unknown"];
const STRUCTS = ["one_form_one", "store_select", "per_store", "per_product", "per_round", "multi_independent_per_submit", "unknown"];
const CASE_TYPES = ["lottery_announcement", "result_announcement", "update", "not_lottery", "unknown"];
const RELS = ["same", "independent", "same_campaign_other", "unknown"];
const OPS = ["link_case", "fill_empty", "change", "merge", "delete", "move_history"];
const ACTIONS = ["fetch_url", "search", "ask_human", "wait", "none"];
const OPP_CLAIMS = ["chain", "store", "products", "applyStart", "applyDeadline", "resultDate", "conditions"] as const;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, max: number) => typeof x === "string" && x.length <= max;

function checkCitations(x: unknown, path: string, errs: string[]): void {
  if (!Array.isArray(x) || x.length > 6) return void errs.push(`${path}: 引用は6件までの配列`);
  x.forEach((c, i) => {
    if (!isObj(c) || !str(c.evidenceId, 20) || !str(c.quote, 400)) errs.push(`${path}[${i}]: evidenceId と quote（400字まで）が必要`);
  });
}

/** 項目の形式エラーの説明。受け取った型と、正しい形の具体例を返す（自動補正はしない。モデルが自分で直すための情報） */
function claimShapeMessage(x: unknown, list: boolean): string {
  const got = Array.isArray(x) ? "配列" : x === null ? "null" : typeof x === "string" ? "文字列" : typeof x === "number" ? "数値" : typeof x === "boolean" ? "真偽値" : typeof x;
  const value = list ? '["値1","値2"]' : '"値"';
  return `オブジェクトが必要（受け取った型: ${got}）。{"value": ${value}, "basis": "fact|inference|unknown", "citations": [{"evidenceId":"E1","quote":"原文の語句"}]} の形で、値は value に入れる${list ? "。value は文字列の配列（空なら [] と basis=unknown）" : ""}`;
}

function checkClaim(x: unknown, path: string, errs: string[], list = false): void {
  if (!isObj(x)) return void errs.push(`${path}: ${claimShapeMessage(x, list)}`);
  if (!BASES.includes(x.basis as string)) errs.push(`${path}.basis: fact/inference/unknown のいずれか`);
  if (list ? !(Array.isArray(x.value) && x.value.length <= 20 && x.value.every((v) => str(v, 200))) : !str(x.value, 600)) errs.push(`${path}.value: 不正な値`);
  checkCitations(x.citations, `${path}.citations`, errs);
}

/** 出力の形式を検査し、不要な項目（自己申告の確信度など）を捨てた正規化済みの出力を返す。エラーがあれば理由（日本語）を返す */
export function parseJudgmentOutput(raw: unknown): { ok: true; output: JudgmentOutput; stripped: string[] } | { ok: false; errors: string[] } {
  const errs: string[] = [];
  const stripped: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["出力がオブジェクトではありません"] };
  for (const k of ["confidence", "score", "certainty", "確信度"]) if (k in raw) stripped.push(k);
  if (!ACCEPTED_OUTPUT_VERSIONS.includes(raw.version as string)) errs.push(`version は ${CONTRACT_VERSION} が必要`);
  checkClaim(raw.caseType, "caseType", errs);
  if (isObj(raw.caseType) && !CASE_TYPES.includes(raw.caseType.value as string)) errs.push("caseType.value: 不正な種別");
  const st = raw.structure;
  if (!isObj(st)) errs.push("structure: オブジェクトが必要");
  else {
    if (!STRUCTS.includes(st.kind as string)) errs.push("structure.kind: 不正な種別");
    if (!BASES.includes(st.basis as string)) errs.push("structure.basis: fact/inference/unknown のいずれか");
    if (!str(st.rationale, 800)) errs.push("structure.rationale: 文字列（800字まで）");
    checkCitations(st.citations, "structure.citations", errs);
    if (st.selectableStores !== undefined && !(Array.isArray(st.selectableStores) && st.selectableStores.length <= 60 && st.selectableStores.every((s) => str(s, 100)))) errs.push("structure.selectableStores: 文字列の配列（60件まで）");
  }
  if (!Array.isArray(raw.opportunities) || raw.opportunities.length > 30) errs.push("opportunities: 30件までの配列");
  else
    raw.opportunities.forEach((o, i) => {
      if (!isObj(o) || !str(o.key, 20) || !str(o.label, 200)) return void errs.push(`opportunities[${i}]: key と label が必要`);
      for (const f of OPP_CLAIMS) if (o[f] !== undefined) checkClaim(o[f], `opportunities[${i}].${f}`, errs, f === "products");
    });
  if (!Array.isArray(raw.relations) || raw.relations.length > 60) errs.push("relations: 60件までの配列");
  else
    raw.relations.forEach((r, i) => {
      if (!isObj(r)) errs.push(`relations[${i}]: オブジェクトが必要`);
      else if (!str(r.opportunityKey, 20) || !str(r.lotteryId, 60) || !RELS.includes(r.relation as string) || !BASES.includes(r.basis as string) || !str(r.rationale, 600)) {
        const bad = [!str(r.opportunityKey, 20) && "opportunityKey", !str(r.lotteryId, 60) && "lotteryId", !RELS.includes(r.relation as string) && "relation（same/independent/same_campaign_other/unknown）", !BASES.includes(r.basis as string) && "basis（fact/inference/unknown）", !str(r.rationale, 600) && "rationale（文字列・600字まで）"].filter(Boolean);
        errs.push(`relations[${i}]: 形式が不正（不足・不正な項目: ${bad.join("、")}）。opportunityKey・lotteryId・relation・basis・citations・rationale をすべて入れる`);
      }
      else checkCitations(r.citations, `relations[${i}].citations`, errs);
    });
  if (!Array.isArray(raw.plannedChanges) || raw.plannedChanges.length > 30) errs.push("plannedChanges: 30件までの配列");
  else raw.plannedChanges.forEach((p, i) => { if (!isObj(p) || !str(p.lotteryId, 60) || !OPS.includes(p.op as string) || !str(p.reason, 400)) errs.push(`plannedChanges[${i}]: 形式が不正`); });
  if (!Array.isArray(raw.unresolved) || raw.unresolved.length > 20) errs.push("unresolved: 20件までの配列");
  else raw.unresolved.forEach((u, i) => { if (!isObj(u) || !str(u.id, 30) || !str(u.question, 400) || !["high", "medium", "low"].includes(u.importance as string)) errs.push(`unresolved[${i}]: 形式が不正`); });
  if (!Array.isArray(raw.nextActions) || raw.nextActions.length > 8) errs.push("nextActions: 8件までの配列");
  else raw.nextActions.forEach((a, i) => { if (!isObj(a) || !ACTIONS.includes(a.kind as string) || !str(a.reason, 400) || (a.target !== undefined && !str(a.target, 600))) errs.push(`nextActions[${i}]: 形式が不正（種類は決まった5つのみ）`); });
  if (errs.length) return { ok: false, errors: errs };
  const out = { ...(raw as unknown as JudgmentOutput), version: CONTRACT_VERSION as typeof CONTRACT_VERSION };
  return { ok: true, output: out, stripped };
}
