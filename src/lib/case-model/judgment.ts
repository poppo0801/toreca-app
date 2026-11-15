/**
 * 判断履歴（Stage 9H-3B・純関数）。AIの読み取りから最終の登録候補まで、「AIが何と読んだか → 何が変わったか → なぜ」を残す。
 * 目的: AIが正しく抽出した情報が、どの処理で変更・破棄されたかを後から追えるようにする（理由の記録が無い変更は「理由の記録なし」として目立たせる）。
 * 同時に、AI調査が必要な案件かの判定（investigationNeeds）もここで行う。
 */
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { productKey } from "@/lib/lottery-match";
import type { IntegrationSummary } from "./integrate";
import { relateDateTimes } from "@/lib/collector/date-phrases";
import { normName } from "@/lib/norm";
import type { AiInputRecord } from "./redact";
import { CASE_FIELD_KEYS, CASE_FIELD_LABEL, isSet, splitList, type Actor, type CaseFieldKey, type CaseFile, type DecisionRecord, type UnreflectedInfo } from "./types";

/** 既存の判断の追跡（collector/understanding.ts の TraceStep と同じ形。依存を避けて型だけ複製） */
export interface TraceLike {
  stage: string;
  field: string;
  value: string;
  by: string;
  note?: string;
}

export interface InvestigationNeed {
  code: "fetch_restricted" | "required_missing" | "conflict" | "chain_unidentified" | "store_unidentified" | "form_undecidable" | "duplicate_doubt" | "weak_evidence" | "spot_check";
  detail: string;
}
export interface InvestigationState {
  needed: boolean;
  /** 調査が必要と判断された理由（調査の前の状態） */
  reasons: InvestigationNeed[];
  /** 登録候補が固まったあと（固定ロジックの連鎖を通ったあと）にも残っている理由。調査で解消したかを見る */
  remaining?: InvestigationNeed[];
  /** 調査を実行したか。実行しなかった場合の理由（フラグ無効・調査機能が未接続など） */
  executed: boolean;
  skipped?: string;
  /** 抜き取り再確認の対象判定（正常と判断された案件の一部。今回は判定の記録だけで、再確認は実行しない） */
  spotCheck?: { rate: number; eligible: boolean; executed: boolean };
  /** 実行した調査の結果の要約（採用・保留した項目の数など） */
  outcome?: { applied: number; held: number; unreflected: number; stopReason?: string };
}

export interface InvestigationSignals {
  /** 取得が制限された（ロボット制限・JS表示）ため、一覧の文面など二次情報から読み取った */
  fetchRestricted?: boolean;
  fetchFailed?: boolean;
  /** 重複・統合の判断が難しい（高確度ではない候補が複数ある等） */
  duplicateDoubt?: boolean;
  /** 同じ抽選の別の記載と値が食い違う項目 */
  conflicts?: CaseFieldKey[];
  /** 系列・店舗を、マスターまたはアカウント情報から特定できなかった */
  chainUnidentified?: boolean;
  storeUnidentified?: boolean;
}

const REQUIRED: CaseFieldKey[] = ["items", "applyDeadline"];

/** AI調査へ渡す条件（正常に見える案件は対象にしない。将来、一部を抽出して再確認する場合もこの関数を通す） */
export function investigationNeeds(c: CaseFile, s: InvestigationSignals = {}): InvestigationState {
  const reasons: InvestigationNeed[] = [];
  if (s.fetchRestricted || s.fetchFailed) reasons.push({ code: "fetch_restricted", detail: "公式ページを取得できず、二次情報から読み取った" });
  const missing = REQUIRED.filter((k) => !isSet(c.fields[k]));
  if (missing.length) reasons.push({ code: "required_missing", detail: `必須情報が不足: ${missing.map((k) => CASE_FIELD_LABEL[k]).join("・")}` });
  const conflicts = [...new Set([...(s.conflicts ?? []), ...CASE_FIELD_KEYS.filter((k) => c.fields[k].state === "conflict")])];
  if (conflicts.length) reasons.push({ code: "conflict", detail: `情報源間の矛盾: ${conflicts.map((k) => CASE_FIELD_LABEL[k]).join("・")}` });
  const chainMissing = !isSet(c.fields.chain);
  if (chainMissing || s.chainUnidentified) reasons.push({ code: "chain_unidentified", detail: "系列を特定できない" });
  if ((!isSet(c.fields.store) && c.fields.form.value !== "store_select" && !chainMissing) || s.storeUnidentified) reasons.push({ code: "store_unidentified", detail: "店舗を特定できない（店舗選択式とも判断できていない）" });
  const listed = splitList(c.fields.selectableStores.value).length;
  if (!isSet(c.fields.form) && (listed >= 2 || /[／、,・]/.test(c.fields.store.value ?? ""))) reasons.push({ code: "form_undecidable", detail: "複数の店舗が挙がっているが、店舗選択式か店舗別かを判断できない" });
  if (s.duplicateDoubt) reasons.push({ code: "duplicate_doubt", detail: "重複・統合の判断が難しい" });
  const weak = (["applyDeadline", "applyStart", "store", "items"] as CaseFieldKey[]).filter((k) => c.fields[k].state === "unverified");
  if (weak.length) reasons.push({ code: "weak_evidence", detail: `根拠が弱い項目: ${weak.map((k) => CASE_FIELD_LABEL[k]).join("・")}` });
  return { needed: reasons.length > 0, reasons, executed: false };
}

/** 文字の2文字組の一致率（言い換え・語順の違う同じ内容の文面を、別の値としない） */
export function bigramSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const g = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const x = grams(a);
  const y = grams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let n = 0;
  for (const t of x) if (y.has(t)) n++;
  return n / (x.size + y.size - n);
}

export const parseDt = (v: string | null): { date: string; time: string } | null => {
  const m = v ? /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(v.trim()) : null;
  return m ? { date: m[1], time: m[2] ?? "" } : null;
};

/** 2つの値が同じ意味か（表記の違い・マスターの正式名称への照合は「変更」にしない） */
export function sameMeaning(k: CaseFieldKey, a: string | null, b: string | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  switch (k) {
    case "chain":
      return chainCanonicalKey(a) === chainCanonicalKey(b) || chainCanonicalKey(a).includes(chainCanonicalKey(b)) || chainCanonicalKey(b).includes(chainCanonicalKey(a));
    case "store": {
      const x = normName(a);
      const y = normName(b);
      return x === y || (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)));
    }
    case "items": {
      const x = splitList(a).map(productKey).filter(Boolean);
      const y = splitList(b).map(productKey).filter(Boolean);
      return x.length > 0 && y.length > 0 && x.every((p) => y.some((q) => p === q || (p.length >= 4 && q.length >= 4 && (p.includes(q) || q.includes(p)))));
    }
    case "selectableStores":
      return splitList(a).map(normName).sort().join("|") === splitList(b).map(normName).sort().join("|");
    case "conditions": {
      const x = a.replace(/\s+/g, "");
      const y = b.replace(/\s+/g, "");
      return x === y || x.includes(y) || y.includes(x) || bigramSimilarity(x, y) >= 0.6;
    }
    case "applyStart":
    case "applyDeadline":
    case "resultStart": {
      // 日時: 境界表現（1〜2分差）・日付のみと時刻つきは同じ意味（9G。別の値として扱って保留・変更の記録を乱発しない）
      const x = parseDt(a);
      const y = parseDt(b);
      return !!x && !!y && relateDateTimes(x, y).same;
    }
    default:
      return a.trim() === b.trim();
  }
}

const FIELD_TRACE: Partial<Record<CaseFieldKey, string[]>> = { chain: ["chain"], store: ["store", "form"], form: ["form", "unit"], selectableStores: ["store", "form"], items: ["product"] };

/** AIの読み取り（before）と最終の登録候補（after）の差分を、判断の履歴にする */
export function diffDecisions(ai: CaseFile, final: CaseFile, trace: TraceLike[] = [], explained: Partial<Record<CaseFieldKey, { by: Actor; reason: string }>> = {}): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (const k of CASE_FIELD_KEYS) {
    const a = ai.fields[k].value;
    const f = final.fields[k].value;
    if (sameMeaning(k, a, f)) continue;
    // 抽選形態: 最終の登録候補では「店舗選択式」のときだけ値が入る。AIが店舗別独立・その他と読んだものが「その他」になるのは変更ではない
    if (k === "form" && a !== "store_select" && f === null) continue;
    if (k === "selectableStores" && !a) continue;
    const steps = (FIELD_TRACE[k] ?? []).length ? trace.filter((t) => (FIELD_TRACE[k] ?? []).includes(t.field) && t.by !== "ai" && (t.stage === "fixed" || t.stage === "match" || t.stage === "form")) : [];
    const step = steps[steps.length - 1];
    const ex = explained[k];
    const by: Actor = ex ? ex.by : step ? (step.by === "master" ? "master" : "fixed") : "fixed";
    const reason = ex ? ex.reason : step ? `${step.stage}: ${step.note ?? step.value}` : "固定ロジックによる変更（理由の記録なし）";
    const kind = a && !f ? "dropped" : a && f ? "changed" : "adopted";
    out.push({ stage: "fixed", field: k, kind, before: a, after: f, by, reason });
  }
  return out;
}

export interface Judgment {
  version: 1;
  at: string;
  aiInput: AiInputRecord | null;
  /** AIの読み取り（項目と状態） */
  ai: Partial<Record<CaseFieldKey, JudgedField>>;
  /** 最終の登録候補の内容 */
  final: Partial<Record<CaseFieldKey, JudgedField>>;
  /** 調査で使った情報源（URL・種類・一次/二次・状態・主催者の確認など）。最大10件 */
  sources: { url: string; kind: string; tier: string; status: string; note?: string }[];
  decisions: DecisionRecord[];
  /** 固定ロジックの検証の指摘（警告）。最大10件 */
  validations: string[];
  duplicates: string[];
  humanHints: string[];
  unreflected: { key: string; value: string; reason: string }[];
  investigation: InvestigationState | null;
  /** 複数の候補・調査結果の統合（同一抽選の判定・項目ごとの採用と不採用の理由・未確認）。統合が行われなかったときは null */
  integration: IntegrationSummary | null;
}

/** 判断履歴に残す項目の要約。根拠（出典URL・原文の短い抜粋・一次/二次・主催者本文か受付表示か）は、先頭の1件だけ */
export interface JudgedField {
  value: string | null;
  state: string;
  by?: string;
  evidence?: { url?: string; quote?: string; tier?: string; basis?: string };
}
const compact = (c: CaseFile, from: CaseFile[] = []): Record<string, JudgedField> => {
  const o: Record<string, JudgedField> = {};
  for (const k of CASE_FIELD_KEYS) {
    const f = c.fields[k];
    if (!f.value) continue;
    // 根拠: その項目自身の根拠。無ければ、同じ値を持つ調査結果の根拠
    const ev = f.evidence[0] ?? from.map((x) => x.fields[k]).find((x) => x.value && sameMeaning(k, x.value, f.value) && x.evidence[0])?.evidence[0];
    o[k] = { value: f.value.slice(0, 160), state: f.state, by: f.by, ...(ev ? { evidence: { ...(ev.url ? { url: ev.url.slice(0, 200) } : {}), ...(ev.quote ? { quote: ev.quote.slice(0, 80) } : {}), ...(ev.tier ? { tier: ev.tier } : {}), ...(ev.basis ? { basis: ev.basis } : {}) } } : {}) };
  }
  return o;
};

export function buildJudgment(o: {
  at: string;
  aiInput: AiInputRecord | null;
  ai: CaseFile;
  final: CaseFile;
  trace?: TraceLike[];
  validations?: string[];
  duplicates?: string[];
  humanHints?: string[];
  extraDecisions?: DecisionRecord[];
  /** 理由が分かっている変更（アカウント特定・調査結果の反映など）。同じ項目の「理由の記録なし」を出さない */
  explained?: Partial<Record<CaseFieldKey, { by: Actor; reason: string }>>;
  /** 調査・統合で未反映になった情報（登録候補に欄が無い・確定していない別の値など） */
  unreflected?: UnreflectedInfo[];
  investigation?: InvestigationState | null;
  /** 調査結果の案件ファイル（根拠・情報源の出どころ。登録候補の項目に根拠を結びつける） */
  investigationCase?: CaseFile | null;
  integration?: IntegrationSummary | null;
}): Judgment {
  const decisions = [...(o.extraDecisions ?? []), ...diffDecisions(o.ai, o.final, o.trace, o.explained)].slice(-60);
  return {
    version: 1,
    at: o.at,
    aiInput: o.aiInput,
    ai: compact(o.ai),
    final: compact(o.final, [o.ai, ...(o.investigationCase ? [o.investigationCase] : [])]),
    sources: [...o.ai.sources, ...(o.investigationCase?.sources ?? [])].slice(0, 10).map((s) => ({ url: s.url.slice(0, 200), kind: s.kind, tier: s.tier, status: s.status, ...(s.note ? { note: s.note.slice(0, 160) } : {}) })),
    decisions,
    validations: (o.validations ?? []).slice(0, 10).map((s) => s.slice(0, 200)),
    duplicates: (o.duplicates ?? []).slice(0, 5).map((s) => s.slice(0, 200)),
    humanHints: (o.humanHints ?? []).slice(0, 8),
    unreflected: [...o.ai.unreflected, ...o.final.unreflected, ...(o.unreflected ?? [])].slice(0, 20).map((u) => ({ key: u.key, value: u.value.slice(0, 200), reason: u.reason })),
    investigation: o.investigation ?? null,
    integration: o.integration ?? null,
  };
}

/** 理由の記録がないまま、AIの読み取りが変更・破棄された項目（監査の入口） */
export const silentChanges = (j: Judgment): DecisionRecord[] => j.decisions.filter((d) => (d.kind === "changed" || d.kind === "dropped") && /理由の記録なし/.test(d.reason));
