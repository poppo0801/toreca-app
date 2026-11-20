/**
 * 実AI評価の実行部（Stage 10E 追加修正）。**モデルを引数で受け取る**ので、テストでは台本のモデル・偽のクライアントで、承認後は実AIアダプタで同じ経路を通る。
 *  - 入力は `inputFor`（正解を読まない）。採点だけが正解を読む。AIの出力は正解として保存しない（出力・正解・採点は別のフィールド）。
 *  - 予算: 総額と1件の上限。1件ごとの枠を、残りの総額を超えない額で作り、枠を使い切る見込みなら呼び出さない（エンジンの予約）。総額に達したら残りの事例は実行しない。
 *  - 検証不能（verifiable=false）の事例は、事実を断定していないかだけを見て、正確性の分母（構造・件数・項目）に含めない。誤統合と誤分割は別集計。
 *  - 記録: モデル・プロンプト版・契約版・事例ごとの状態/試行回数/費用（不明は null）/違反コード/出力。APIキー等の秘密値は記録しない。
 */
import { BudgetPools } from "../budget";
import { CONTRACT_VERSION, type JudgmentOutput } from "../contract";
import { judgeCase } from "../engine";
import type { JudgmentModel } from "../model";
import { inputFor, scoreCase, type CaseScore, type Gold, type ReplayCase } from "./replay";

export interface CaseRecord {
  id: string;
  status: string;
  attempts: number;
  /** この事例の費用（円）。不明な呼び出しがあれば予約額で計上した値（unknownCost=true） */
  spentJpy: number;
  unknownCost: boolean;
  violationCodes: string[];
  /** 試行ごとの不合格・形式エラーの理由（誤り分析用。各200字まで・最大12件）。原文・秘密値は含まない */
  violationMessages: string[];
  dropped: string[];
  score: CaseScore | null;
  /** AIの出力（正解とは別。再現・誤り分析用） */
  output: JudgmentOutput | null;
}

export interface RunRecord {
  runId: string;
  startedAt: string;
  contractVersion: string;
  modelId: string;
  promptVersion: string;
  totalCapJpy: number;
  perCaseCapJpy: number;
  spentJpy: number;
  stoppedByBudget: boolean;
  cases: CaseRecord[];
  summary: Summary;
}

export interface Summary {
  casesRun: number;
  casesSkippedByBudget: number;
  verifiableCases: number;
  unverifiableCases: number;
  accepted: number;
  partial: number;
  unresolved: number;
  modelErrors: number;
  structureCorrect: number;
  structureScored: number;
  countCorrect: number;
  countScored: number;
  fieldCorrect: number;
  fieldScored: number;
  falseMerge: number;
  falseSplit: number;
  unsupportedFacts: number;
  mustNotChangeViolations: number;
  conditionsCorrect: number;
  conditionsScored: number;
}

export function summarize(records: CaseRecord[], skipped: number): Summary {
  const s: Summary = { casesRun: records.length, casesSkippedByBudget: skipped, verifiableCases: 0, unverifiableCases: 0, accepted: 0, partial: 0, unresolved: 0, modelErrors: 0, structureCorrect: 0, structureScored: 0, countCorrect: 0, countScored: 0, fieldCorrect: 0, fieldScored: 0, falseMerge: 0, falseSplit: 0, unsupportedFacts: 0, mustNotChangeViolations: 0, conditionsCorrect: 0, conditionsScored: 0 };
  for (const r of records) {
    if (r.status === "accepted") s.accepted++;
    else if (r.status === "partial") s.partial++;
    else if (r.status === "model_error") s.modelErrors++;
    else s.unresolved++;
    const sc = r.score;
    if (!sc) continue;
    if (!sc.verifiable) {
      s.unverifiableCases++;
      s.unsupportedFacts += sc.unsupportedFacts; // 検証不能の事例は、事実を断定していないかだけを見る（分母に入れない）
      continue;
    }
    s.verifiableCases++;
    if (sc.structureOk !== null) { s.structureScored++; if (sc.structureOk) s.structureCorrect++; }
    if (sc.countOk !== null) { s.countScored++; if (sc.countOk) s.countCorrect++; }
    for (const ok of Object.values(sc.fieldsOk)) { s.fieldScored++; if (ok) s.fieldCorrect++; }
    if (sc.conditionsOk !== null) { s.conditionsScored++; if (sc.conditionsOk) s.conditionsCorrect++; }
    s.falseMerge += sc.falseMerge;
    s.falseSplit += sc.falseSplit;
    s.unsupportedFacts += sc.unsupportedFacts + sc.storeAsserted;
    s.mustNotChangeViolations += sc.mustNotChangeViolations;
  }
  return s;
}

export interface RunArgs {
  model: JudgmentModel;
  cases: ReplayCase[];
  gold: Record<string, Gold>;
  now: string;
  totalCapJpy: number;
  perCaseCapJpy: number;
  runId?: string;
  clock?: () => Date;
}

export async function runEvaluation(a: RunArgs): Promise<RunRecord> {
  const clock = a.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  let spent = 0;
  let stoppedByBudget = false;
  const records: CaseRecord[] = [];
  let skipped = 0;
  for (const c of a.cases) {
    const room = Math.min(a.perCaseCapJpy, a.totalCapJpy - spent);
    if (stoppedByBudget || !(room > 0)) {
      stoppedByBudget = true;
      skipped++;
      continue;
    }
    const input = await inputFor(c, a.now);
    const budget = new BudgetPools({ judgment: room, investigation: 0, discovery: 0 });
    const r = await judgeCase({ model: a.model, budget, pool: "judgment" }, input);
    const st = budget.state("judgment");
    spent += st.spentJpy;
    const g = a.gold[c.id];
    records.push({
      id: c.id,
      status: r.status,
      attempts: r.attempts,
      spentJpy: Math.round(st.spentJpy * 10000) / 10000,
      unknownCost: r.unknownCost || st.unknownCostCalls > 0,
      violationCodes: [...new Set(r.violations.map((v) => v.code))],
      violationMessages: r.log.flatMap((l) => l.violations.map((v) => `#${l.n} ${v.path}: ${v.message}`.slice(0, 200))).slice(0, 12),
      dropped: r.dropped,
      score: g ? scoreCase(c.id, g, r.output) : null,
      output: r.output,
    });
    if (r.status === "budget_stopped") stoppedByBudget = true;
  }
  return {
    runId: a.runId ?? `judgment-${startedAt.replace(/[^0-9]/g, "").slice(0, 14)}`,
    startedAt,
    contractVersion: CONTRACT_VERSION,
    modelId: a.model.id,
    promptVersion: a.model.promptVersion,
    totalCapJpy: a.totalCapJpy,
    perCaseCapJpy: a.perCaseCapJpy,
    spentJpy: Math.round(spent * 10000) / 10000,
    stoppedByBudget,
    cases: records,
    summary: summarize(records, skipped),
  };
}

/** 事前の見積もり（API・ネットワークに接続しない）。各事例の入力から最大費用を計算し、承認を求める値（推定最大費用）を出す。1事例あたりの最大回数は 1（初回）＋再判断2回 */
export async function estimateRun(model: JudgmentModel, cases: ReplayCase[], now: string, maxAttemptsPerCase = 3): Promise<{ perCase: { id: string; maxOneCallJpy: number; maxCaseJpy: number }[]; maxTotalJpy: number }> {
  const perCase = [];
  for (const c of cases) {
    const input = await inputFor(c, now);
    const one = model.maxCostJpy(input);
    perCase.push({ id: c.id, maxOneCallJpy: Math.round(one * 10000) / 10000, maxCaseJpy: Math.round(one * maxAttemptsPerCase * 10000) / 10000 });
  }
  return { perCase, maxTotalJpy: Math.round(perCase.reduce((s, x) => s + x.maxCaseJpy, 0) * 10000) / 10000 };
}
