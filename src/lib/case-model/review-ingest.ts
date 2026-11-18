/**
 * 人間評価（review-answers）の取り込みと履歴の保存（Stage 9H-3M・純関数）。
 * 評価を、正解（gold）・参考情報（reference）・使わない（excluded）に分け、元のAIの判定と人間の修正の履歴を失わず保存する。
 *  - gold:      usableAsGold=true（正しい・一部修正・間違い）。回帰検証と学習に使う
 *  - reference: 正解にしない（判断できない・未評価）が、評価者の修正・コメントは参考として保持する
 *  - excluded:  修正もコメントも無く、参考にもならない
 * 判断できない案件・未評価の案件を、確定した正解として扱わない。評価の内容は評価者の判断であり、情報源の事実とは区別する。
 * 履歴は評価ID（evaluationId）で冪等にまとめ、内容（digest）が変わった評価は版として残す（上書きして失わない）。
 */
import { createHash } from "node:crypto";

export type EvalClass = "correct" | "partial" | "wrong" | "unknown" | "unevaluated";
export type Use = "gold" | "reference" | "excluded";

export interface AnswerRow {
  evaluationId?: string;
  caseId?: string;
  caseDigest?: string;
  source?: { url?: string; title?: string };
  aiOriginal?: { extracted?: Record<string, unknown> | null; formJudgment?: unknown; warnings?: string[] };
  human?: { verdict?: string | null; usableAsGold?: boolean; corrections?: { field: string; correctValue?: string }[]; comment?: string; evaluatedAt?: string | null };
}
export interface AnswerFile {
  setId?: string;
  setDigest?: string;
  exportedAt?: string;
  results?: AnswerRow[];
}

export interface IngestedCase {
  evaluationId: string;
  caseId: string;
  class: EvalClass;
  use: Use;
  /** 人間が店舗選択式と訂正した（正解の場合）／参考の場合は評価者の意図（確定ではない） */
  humanStoreSelect: boolean;
  corrections: { field: string; correctValue: string }[];
  comment: string;
  evaluatedAt: string | null;
  /** 元のAIの出力（書き換えない） */
  aiOriginal: { extracted: Record<string, unknown> | null; formJudgment: unknown };
  source: { url: string; title: string };
  digest: string;
}

const SELECT_WORD = /店舗選択/;

export function classifyAnswer(r: AnswerRow): { class: EvalClass; use: Use } {
  const h = r.human;
  const v = h?.verdict ?? null;
  const hasInfo = (h?.corrections ?? []).some((c) => (c.correctValue ?? "").trim() !== "" || c.field) || !!(h?.comment ?? "").trim();
  const cls: EvalClass = !v ? "unevaluated" : v === "correct" ? "correct" : v === "partial" ? "partial" : v === "wrong" ? "wrong" : v === "unknown" ? "unknown" : "unevaluated";
  if (h?.usableAsGold === true && cls !== "unknown" && cls !== "unevaluated") return { class: cls, use: "gold" };
  return { class: cls, use: hasInfo ? "reference" : "excluded" };
}

export function ingestAnswers(f: AnswerFile): IngestedCase[] {
  return (f.results ?? []).map((r) => {
    const { class: cls, use } = classifyAnswer(r);
    const corrections = (r.human?.corrections ?? []).map((c) => ({ field: c.field, correctValue: (c.correctValue ?? "").trim() }));
    const comment = (r.human?.comment ?? "").trim();
    const humanStoreSelect = corrections.some((c) => SELECT_WORD.test(c.correctValue)) || (use !== "gold" && /店舗選択式/.test(comment));
    const body = { cls, use, corrections, comment, ai: r.aiOriginal?.extracted ?? null };
    return {
      evaluationId: r.evaluationId ?? `${f.setId ?? "?"}-${r.caseId ?? "?"}`,
      caseId: r.caseId ?? "",
      class: cls,
      use,
      humanStoreSelect,
      corrections,
      comment,
      evaluatedAt: r.human?.evaluatedAt ?? null,
      aiOriginal: { extracted: r.aiOriginal?.extracted ?? null, formJudgment: r.aiOriginal?.formJudgment ?? null },
      source: { url: r.source?.url ?? "", title: r.source?.title ?? "" },
      digest: createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16),
    };
  });
}

export interface LedgerEntry {
  evaluationId: string;
  setId: string;
  versions: IngestedCase[];
}
export interface Ledger {
  version: 1;
  entries: LedgerEntry[];
}

/** 履歴への追加（冪等）。同じ評価で内容が同じなら何もしない。内容が変わった評価は版として追加する（古い版は残す） */
export function mergeLedger(ledger: Ledger | null, setId: string, cases: IngestedCase[]): { ledger: Ledger; added: number; revised: number; unchanged: number } {
  const next: Ledger = { version: 1, entries: (ledger?.entries ?? []).map((e) => ({ ...e, versions: [...e.versions] })) };
  let added = 0;
  let revised = 0;
  let unchanged = 0;
  for (const c of cases) {
    const cur = next.entries.find((e) => e.evaluationId === c.evaluationId);
    if (!cur) {
      next.entries.push({ evaluationId: c.evaluationId, setId, versions: [c] });
      added++;
    } else if (cur.versions.at(-1)?.digest === c.digest) unchanged++;
    else {
      cur.versions.push(c);
      revised++;
    }
  }
  return { ledger: next, added, revised, unchanged };
}

/** 履歴の最新版だけを使う集計の入力（学習・回帰検証用）。gold のみ */
export function latestGold(ledger: Ledger): IngestedCase[] {
  return ledger.entries.map((e) => e.versions.at(-1)!).filter((c) => c.use === "gold");
}
