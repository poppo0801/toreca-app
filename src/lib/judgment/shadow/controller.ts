/**
 * シャドー実行の制御（Stage 10F）。旧方式が唯一の正式な経路。ここは**比較用の判断を1件追記する**だけで、
 * 抽選カード・応募/当選/購入履歴・通知・保護対象のどれにも書かない（判断履歴の sink も渡さない＝DBに接続しない）。
 * 失敗・遅延・予算超過・無効のいずれでも例外を投げず、呼び出し元（旧方式）の処理を止めない・待たせない（打ち切りあり）。
 */
import { BudgetPools } from "../budget";
import type { JudgmentInput } from "../contract";
import { judgeCase } from "../engine";
import type { JudgmentModel } from "../model";
import { assertSafeRecord, compareLegacyNew, hashKey, type LegacySummary, type ShadowRecord, type ShadowSink, type ShadowStatus } from "./record";
import { shadowConfig, type ShadowConfig } from "./config";

export type ShadowSkip = "disabled" | "duplicate" | "rate_limited" | "busy" | "budget_exhausted" | "bad_input" | "internal_error";
export interface ShadowOutcome {
  ran: boolean;
  skipped?: ShadowSkip | ShadowConfig["reason"];
  record?: ShadowRecord;
}

export interface ShadowDeps {
  model: JudgmentModel;
  sink: ShadowSink;
  /** 設定の取得（既定: 呼び出しごとに環境変数を読み直す＝緊急停止が即時に効く） */
  config?: () => ShadowConfig;
  now?: () => number;
}

export class ShadowController {
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly starts: number[] = [];
  private readonly budget: BudgetPools;
  private budgetCap: number;
  /** 保存に失敗した件数（失敗しても旧方式・シャドーの実行は継続する） */
  sinkFailures = 0;
  unsafeRecordsDropped = 0;

  constructor(private readonly deps: ShadowDeps) {
    const cfg = (deps.config ?? shadowConfig)();
    this.budgetCap = cfg.budgetCapJpy;
    this.budget = new BudgetPools({ discovery: 0, judgment: cfg.budgetCapJpy, investigation: 0 });
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** 費用の使用状況（円）。緊急時の確認用 */
  spentJpy(): number {
    return this.budget.state("judgment").spentJpy;
  }

  /**
   * 1件のシャドー判断。**例外を投げない**。legacy は要約のコピーを使い、元のオブジェクトに触れない。
   * caseKey は呼び出し側の案件識別子（記録前にハッシュ化される。生のIDは保存しない）。
   */
  async observe(args: { caseKey: string; input: JudgmentInput; legacy: LegacySummary }): Promise<ShadowOutcome> {
    try {
      const cfg = (this.deps.config ?? shadowConfig)();
      if (!cfg.enabled) return { ran: false, skipped: cfg.reason === "enabled" ? "disabled" : cfg.reason };
      if (!args?.input || !args.legacy || typeof args.caseKey !== "string") return { ran: false, skipped: "bad_input" };
      const key = hashKey(`${this.deps.model.promptVersion}|${JSON.stringify(args.input)}`);
      if (this.seen.has(key) || this.inFlight.has(key)) return { ran: false, skipped: "duplicate" };
      if (this.inFlight.size >= cfg.maxConcurrent) return { ran: false, skipped: "busy" };
      const t = this.now;
      while (this.starts.length && t - this.starts[0] > cfg.windowMs) this.starts.shift();
      if (this.starts.length >= cfg.maxPerWindow) return { ran: false, skipped: "rate_limited" };
      // 1件の上限（円）。予約が予算を超える見込みなら呼ばない
      const reserve = Math.min(this.deps.model.maxCostJpy(args.input), cfg.perCaseCapJpy);
      if (this.budget.remaining("judgment") < reserve) return { ran: false, skipped: "budget_exhausted" };

      this.inFlight.add(key);
      this.starts.push(t);
      const legacy: LegacySummary = { structure: args.legacy.structure, opportunityCount: args.legacy.opportunityCount, duplicateCount: args.legacy.duplicateCount };
      const spentBefore = this.spentJpy();
      let status: ShadowStatus;
      let result: Awaited<ReturnType<typeof judgeCase>> | null = null;
      try {
        const run = judgeCase({ model: this.deps.model, budget: this.budget, pool: "judgment", maxRetries: 2 }, args.input); // sink なし＝DBに書かない
        run.catch(() => undefined); // 打ち切り後の遅延した失敗が未処理にならないように
        let timer: ReturnType<typeof setTimeout> | undefined;
        const raced = await Promise.race([run, new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), cfg.timeoutMs)))]).finally(() => clearTimeout(timer));
        if (raced === "timeout") status = "timeout";
        else {
          result = raced;
          status = raced.status;
        }
      } catch {
        status = "error";
      } finally {
        this.inFlight.delete(key);
        this.seen.add(key);
      }
      const out = result?.output ?? null;
      const facts = out ? [out.caseType, ...out.opportunities.flatMap((o) => [o.chain, o.store, o.products, o.applyStart, o.applyDeadline, o.resultDate, o.conditions])].filter((c) => c && c.basis === "fact") : [];
      const rec: ShadowRecord = {
        v: 1,
        at: new Date(t).toISOString(),
        caseKey: hashKey(args.caseKey),
        promptVersion: this.deps.model.promptVersion,
        modelId: this.deps.model.id,
        mode: "mock",
        status,
        attempts: result?.attempts ?? 0,
        costJpy: status === "timeout" || status === "error" ? null : result?.unknownCost ? null : Math.round((this.spentJpy() - spentBefore) * 10000) / 10000,
        latencyMs: Math.max(0, this.now - t),
        legacy,
        next: out
          ? {
              structure: out.structure.kind,
              opportunityCount: out.opportunities.length,
              relations: {
                same: out.relations.filter((r) => r.relation === "same").length,
                same_campaign_other: out.relations.filter((r) => r.relation === "same_campaign_other").length,
                independent: out.relations.filter((r) => r.relation === "independent").length,
                unknown: out.relations.filter((r) => r.relation === "unknown").length,
              },
              unresolvedCount: out.unresolved.length,
              droppedCount: result?.dropped.length ?? 0,
              violationCodes: [...new Set((result?.violations ?? []).map((v) => v.code))],
              factClaims: facts.length,
              citedFactClaims: facts.filter((c) => (c?.citations.length ?? 0) > 0).length,
            }
          : null,
        compare: compareLegacyNew(legacy, out),
      };
      try {
        assertSafeRecord(rec);
        await this.deps.sink.write(rec);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("安全でない")) this.unsafeRecordsDropped++;
        else this.sinkFailures++;
        return { ran: true, record: undefined };
      }
      return { ran: true, record: rec };
    } catch {
      return { ran: false, skipped: "internal_error" };
    }
  }
}
