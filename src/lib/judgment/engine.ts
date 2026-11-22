/**
 * 統合AI判断エンジン（Stage 10E）。1つの入力→1つのAI判断→検証→（不合格なら理由を返して限定回数の再判断）→採用/部分採用/未確定。
 *  - 意味判断はモデル（AI）。ここと検証層は、根拠の実在・整合・保護・費用を検査するだけで、別の意味結論を作らない。
 *  - 再判断は最大 maxRetries 回（既定2）。費用は実行の前に予約し、上限を超える見込みなら呼ばない。モデルの失敗が連続2回で止める。
 *  - 不合格の主張は採用から外す（未確定として残る）。AIの自己申告の確信度は契約に無く、あっても捨てる。
 *  - 判断は sink へ追記する（case_judgments。根拠のハッシュ・取得状況・モデル/プロンプト版・費用つき）。保存した判断は次回の入力に戻る（build-input）。
 *  - DB・本番・通常収集には接続しない（10Fで接続）。実AIの呼び出しはモデルの実装側（10Eでは未実装・承認制）。
 */
import { BudgetStop, type BudgetPools, type PoolName } from "./budget";
import { parseJudgmentOutput, type JudgmentInput, type JudgmentOutput } from "./contract";
import type { JudgmentModel } from "./model";
import { dropViolatingClaims, verifyJudgment, type Violation } from "./verify";
import type { recordJudgment } from "@/lib/server/case-foundation";

export type RecordArg = Parameters<typeof recordJudgment>[1];
export type JudgmentSink = (r: RecordArg) => Promise<unknown>;

export interface EngineDeps {
  model: JudgmentModel;
  budget: BudgetPools;
  pool?: PoolName;
  sink?: JudgmentSink;
  householdId?: string;
  maxRetries?: number;
}

export type JudgmentStatus = "accepted" | "partial" | "unresolved" | "budget_stopped" | "model_error";

export interface AttemptLog {
  n: number;
  outcome: "ok" | "format_error" | "violations" | "model_error" | "budget_stop";
  violations: Violation[];
  costJpy: number | null;
}

export interface JudgmentResult {
  status: JudgmentStatus;
  output: JudgmentOutput | null;
  violations: Violation[];
  dropped: string[];
  attempts: number;
  log: AttemptLog[];
  /** 費用が不明な呼び出しがあったか（その分は予約額で計上済み） */
  unknownCost: boolean;
  strippedFields: string[];
}

export async function judgeCase(deps: EngineDeps, input: JudgmentInput): Promise<JudgmentResult> {
  const pool = deps.pool ?? "judgment";
  const maxRetries = deps.maxRetries ?? 2;
  const log: AttemptLog[] = [];
  let feedback: string[] | undefined;
  let consecutiveErrors = 0;
  let unknownCost = false;
  let lastViolations: Violation[] = [];
  let lastOutput: JudgmentOutput | null = null;
  let stripped: string[] = [];

  for (let n = 0; n <= maxRetries; n++) {
    const cur = feedback ? { ...input, feedback } : input;
    let ticket;
    try {
      ticket = deps.budget.reserve(pool, deps.model.maxCostJpy(cur));
    } catch (e) {
      if (e instanceof BudgetStop) {
        log.push({ n, outcome: "budget_stop", violations: [], costJpy: null });
        return finish(deps, input, { status: "budget_stopped", output: null, violations: lastViolations, dropped: [], attempts: n, log, unknownCost, strippedFields: stripped });
      }
      throw e;
    }
    let call;
    try {
      call = await deps.model.judge(cur);
    } catch {
      deps.budget.release(ticket, false); // 失敗の費用は不明＝安全側で返却しない
      unknownCost = true;
      consecutiveErrors++;
      log.push({ n, outcome: "model_error", violations: [], costJpy: null });
      if (consecutiveErrors >= 2) return finish(deps, input, { status: "model_error", output: null, violations: lastViolations, dropped: [], attempts: n + 1, log, unknownCost, strippedFields: stripped });
      continue;
    }
    consecutiveErrors = 0;
    deps.budget.settle(ticket, call.costJpy);
    if (call.costJpy == null) unknownCost = true;

    const parsed = parseJudgmentOutput(call.raw);
    if (!parsed.ok) {
      lastViolations = parsed.errors.map((m) => ({ code: "no_citation" as const, path: "format", message: `形式エラー: ${m}` }));
      log.push({ n, outcome: "format_error", violations: lastViolations, costJpy: call.costJpy });
      feedback = parsed.errors.slice(0, 8);
      continue;
    }
    stripped = parsed.stripped;
    lastOutput = parsed.output;
    const vs = verifyJudgment(input, parsed.output);
    if (!vs.length) {
      log.push({ n, outcome: "ok", violations: [], costJpy: call.costJpy });
      return finish(deps, input, { status: "accepted", output: parsed.output, violations: [], dropped: [], attempts: n + 1, log, unknownCost, strippedFields: stripped });
    }
    lastViolations = vs;
    log.push({ n, outcome: "violations", violations: vs, costJpy: call.costJpy });
    feedback = vs.slice(0, 8).map((v) => `${v.path}: ${v.message}`);
  }

  // 再判断の上限に達した: 検証を通らなかった主張を外して部分採用（別の結論は作らない）。出力が一度も得られなければ未確定
  if (!lastOutput) return finish(deps, input, { status: "unresolved", output: null, violations: lastViolations, dropped: [], attempts: log.length, log, unknownCost, strippedFields: stripped });
  const { output, dropped } = dropViolatingClaims(lastOutput, lastViolations);
  return finish(deps, input, { status: "partial", output, violations: lastViolations, dropped, attempts: log.length, log, unknownCost, strippedFields: stripped });
}

/** 判断履歴へ追記して結果を返す（保存に失敗しても判断結果は返す） */
async function finish(deps: EngineDeps, input: JudgmentInput, r: JudgmentResult): Promise<JudgmentResult> {
  if (deps.sink && deps.householdId) {
    const base = { householdId: deps.householdId, caseId: input.caseId, judgeKind: "ai" as const, modelId: deps.model.id, promptVersion: deps.model.promptVersion };
    const ev = (cs: { evidenceId: string }[] | undefined) => {
      const e = input.evidence.find((x) => x.id === cs?.[0]?.evidenceId);
      return e ? { evidenceHash: e.hash, evidenceUrl: e.url, observedAt: e.fetchedAt, evidenceStatus: e.status } : {};
    };
    const rows: RecordArg[] = [];
    if (r.output) {
      const o = r.output;
      rows.push({ ...base, kind: "structure", subject: "structure", claimBasis: o.structure.basis, value: `${o.structure.kind}: ${o.structure.rationale}`, ...ev(o.structure.citations) });
      o.opportunities.forEach((op) => {
        for (const f of ["chain", "store", "products", "applyStart", "applyDeadline", "resultDate", "conditions"] as const) {
          const c = op[f];
          if (c) rows.push({ ...base, kind: "field", subject: `${op.key}.${f}`, claimBasis: c.basis, value: Array.isArray(c.value) ? c.value.join(" / ") : String(c.value), ...ev(c.citations) });
        }
      });
      o.relations.forEach((x) => rows.push({ ...base, lotteryId: x.lotteryId, kind: "relation", subject: x.opportunityKey, claimBasis: x.basis, relation: x.relation, value: x.rationale, ...ev(x.citations) }));
    }
    r.dropped.forEach((d) => rows.push({ ...base, kind: "reeval", subject: d.slice(0, 80), claimBasis: "unknown", judgeKind: "fixed", value: `検証で不採用: ${d}`, reevalReason: r.violations.find((v) => v.path === d || d.startsWith(v.path))?.message.slice(0, 190) ?? "", reevalResult: "未確定として保留" }));
    if (!rows.length) rows.push({ ...base, kind: "reeval", subject: "judgment", claimBasis: "unknown", judgeKind: "fixed", value: `判断なし: ${r.status}`, reevalReason: r.violations[0]?.message.slice(0, 190) ?? "", reevalResult: r.status, lotteryId: input.related[0]?.lotteryId ?? null });
    // 費用: 全ての呼び出しの費用が分かるときだけ合計を記録する（不明が混ざるなら NULL。0円にしない）
    if (rows.length && r.log.length && r.log.every((l) => l.outcome === "budget_stop" || l.costJpy != null)) rows[0].costJpy = r.log.reduce((s, l) => s + (l.costJpy ?? 0), 0);
    for (const row of rows) {
      try {
        await deps.sink(row);
      } catch {
        /* 保存の失敗で判断結果を失わない */
      }
    }
  }
  return r;
}
