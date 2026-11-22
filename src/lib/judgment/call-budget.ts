/**
 * API呼び出しの**ハード上限**（Stage 10M）。回数と費用を、**すべての種類の呼び出し（判断・再試行・再評価・画像の書き起こし・一覧の項目判断）で合算**して管理する。
 *  - 呼び出しの**開始時**に1回と数える（失敗・再試行も数える）。回数が上限に達している、または費用の予約が残額を超える場合は、呼び出さずに拒否する。
 *  - 上限に達したら安全に停止できるよう、拒否の理由（calls / cost）を返す。呼び出し側は未処理を明示して終了し、再開時に処理済みを再利用する。
 */
import type { JudgmentModel, ModelCall } from "./model";
import type { Transcriber } from "./image-transcriber";

export type CallKind = "judge" | "plan" | "image" | "list_batch" | "list_retry" | string;
export type StopReason = "calls" | "cost" | null;

export class CallBudget {
  calls = 0;
  costJpy = 0;
  readonly byKind: Record<string, { calls: number; costJpy: number }> = {};
  private reserved = 0;
  constructor(readonly opts: { maxCalls: number; maxCostJpy: number }) {}

  get remainingCalls(): number {
    return Math.max(0, this.opts.maxCalls - this.calls);
  }
  get remainingJpy(): number {
    return Math.max(0, this.opts.maxCostJpy - this.costJpy - this.reserved);
  }
  /** 呼び出してよいか（回数の余りと、費用の予約が残額に収まること）。数えない（確認のみ） */
  check(reserveJpy = 0): { ok: true } | { ok: false; reason: Exclude<StopReason, null> } {
    if (this.calls >= this.opts.maxCalls) return { ok: false, reason: "calls" };
    if (reserveJpy > this.remainingJpy + 1e-9) return { ok: false, reason: "cost" };
    return { ok: true };
  }
  /** 呼び出しを開始する（1回と数え、費用を予約する）。拒否されたら理由を返し、数えない */
  start(kind: CallKind, reserveJpy = 0): { ok: true; finish: (actualJpy: number | null) => void } | { ok: false; reason: Exclude<StopReason, null> } {
    const c = this.check(reserveJpy);
    if (!c.ok) return c;
    this.calls++;
    this.reserved += reserveJpy;
    const k = (this.byKind[kind] ??= { calls: 0, costJpy: 0 });
    k.calls++;
    let done = false;
    return {
      ok: true,
      finish: (actualJpy) => {
        if (done) return;
        done = true;
        this.reserved = Math.max(0, this.reserved - reserveJpy);
        const spent = actualJpy ?? reserveJpy; // 費用が不明な呼び出しは、予約額で計上する（0円にしない）
        this.costJpy += spent;
        k.costJpy += spent;
      },
    };
  }
  summary(): { calls: number; costJpy: number; maxCalls: number; maxCostJpy: number; byKind: Record<string, { calls: number; costJpy: number }> } {
    return { calls: this.calls, costJpy: Math.round(this.costJpy * 10000) / 10000, maxCalls: this.opts.maxCalls, maxCostJpy: this.opts.maxCostJpy, byKind: this.byKind };
  }
}

/**
 * 1件（1案件）あたりの費用のハード上限（Stage 10X）。親の CallBudget（全体の上限）を共有し、その案件の費用が上限を超える呼び出しは開始しない。
 * 親の回数・費用の計上はそのまま親に積まれる（全体の上限と1件の上限のどちらかに達したら止まる）。
 */
export class CaseBudget extends CallBudget {
  private caseSpent = 0;
  private caseReserved = 0;
  constructor(private readonly parent: CallBudget, private readonly capJpy: number) {
    super({ maxCalls: parent.opts.maxCalls, maxCostJpy: parent.opts.maxCostJpy });
  }
  get caseCostJpy(): number {
    return this.caseSpent;
  }
  override get remainingCalls(): number {
    return this.parent.remainingCalls;
  }
  override get remainingJpy(): number {
    return Math.max(0, Math.min(this.parent.remainingJpy, this.capJpy - this.caseSpent - this.caseReserved));
  }
  override check(reserveJpy = 0): { ok: true } | { ok: false; reason: Exclude<StopReason, null> } {
    if (reserveJpy > this.capJpy - this.caseSpent - this.caseReserved + 1e-9) return { ok: false, reason: "cost" };
    return this.parent.check(reserveJpy);
  }
  override start(kind: CallKind, reserveJpy = 0): { ok: true; finish: (actualJpy: number | null) => void } | { ok: false; reason: Exclude<StopReason, null> } {
    const c = this.check(reserveJpy);
    if (!c.ok) return c;
    const s = this.parent.start(kind, reserveJpy);
    if (!s.ok) return s;
    this.caseReserved += reserveJpy;
    let done = false;
    return {
      ok: true,
      finish: (actualJpy) => {
        if (done) return;
        done = true;
        this.caseReserved = Math.max(0, this.caseReserved - reserveJpy);
        this.caseSpent += actualJpy ?? reserveJpy;
        s.finish(actualJpy);
      },
    };
  }
  override summary(): ReturnType<CallBudget["summary"]> {
    const p = this.parent.summary();
    return { ...p, costJpy: Math.round(this.caseSpent * 10000) / 10000, maxCostJpy: this.capJpy };
  }
}

export class CallLimitError extends Error {
  constructor(readonly reason: "calls" | "cost") {
    super(`call_limit:${reason}`);
  }
}

/** 判断モデルの全ての呼び出し（再試行・再評価を含む）を、共通の上限で数える。上限に達したら呼び出さずに例外（エンジンは失敗として扱う） */
export function withCallBudget(model: JudgmentModel, budget: CallBudget, kind: CallKind = "judge"): JudgmentModel {
  const wrap = async (call: () => Promise<ModelCall<unknown>>, reserve: number, k: CallKind): Promise<ModelCall<unknown>> => {
    const s = budget.start(k, reserve);
    if (!s.ok) throw new CallLimitError(s.reason);
    try {
      const r = await call();
      s.finish(r.costJpy ?? null);
      return r;
    } catch (e) {
      s.finish(null);
      throw e;
    }
  };
  return {
    id: model.id,
    promptVersion: model.promptVersion,
    maxCostJpy: (input) => model.maxCostJpy(input),
    judge: (input) => wrap(() => model.judge(input), Math.min(model.maxCostJpy(input), 3), kind),
    planAction: (req) => wrap(() => model.planAction(req), 0.3, "plan"),
  };
}

/** 画像の書き起こしも、共通の上限で数える。上限に達したら null（書き起こせなかった＝照合できない） */
export function withCallBudgetTranscriber(t: Transcriber, budget: CallBudget, reserveJpy = 0.6): Transcriber {
  return async (img) => {
    const s = budget.start("image", reserveJpy);
    if (!s.ok) return null;
    try {
      const r = await t(img);
      s.finish(r?.costJpy ?? null);
      return r;
    } catch (e) {
      s.finish(null);
      throw e;
    }
  };
}

/** 別の予算（ジョブごとの小さな予算）の使用分を、実行全体の予算に合算する（ハード上限の合算管理） */
export function absorbBudget(into: CallBudget, from: CallBudget): void {
  into.calls += from.calls;
  into.costJpy += from.costJpy;
  for (const [k, v] of Object.entries(from.byKind)) {
    const t = (into.byKind[k] ??= { calls: 0, costJpy: 0 });
    t.calls += v.calls;
    t.costJpy += v.costJpy;
  }
}
