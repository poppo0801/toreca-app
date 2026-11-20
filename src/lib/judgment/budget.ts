/**
 * 費用の予算枠（Stage 10E・純粋なロジック）。AIはこのクラスに触れず、上限を変更できない（固定制御）。
 *  - 枠を分ける: 新規発見（discovery）・案件の判断（judgment）・追加調査（investigation）。**ある枠は別の枠から借りない**
 *    （再調査が新規発見の枠を食いつぶさない）。
 *  - 実行の**前**に最大費用を予約し、上限を超える見込みなら呼び出さずに止める。
 *  - **費用が不明（null）のときは、予約した最大額を使ったものとして計上する（0円としない）**。
 * 既存の `RealRunGuard`（実AI評価の関門・台帳）は実API用。ここは判断・調査エンジンの枠の管理で、将来これを実際の費用台帳（`ai_budget_reservations`）へ接続する（10F）。
 */
export type PoolName = "discovery" | "judgment" | "investigation";

export class BudgetStop extends Error {
  constructor(readonly pool: PoolName, message: string) {
    super(message);
  }
}

export interface PoolState {
  capJpy: number;
  spentJpy: number;
  unknownCostCalls: number;
}

export interface Ticket {
  pool: PoolName;
  maxJpy: number;
  settled: boolean;
}

export class BudgetPools {
  private pools: Record<PoolName, PoolState>;
  constructor(caps: Record<PoolName, number>) {
    this.pools = {
      discovery: { capJpy: caps.discovery, spentJpy: 0, unknownCostCalls: 0 },
      judgment: { capJpy: caps.judgment, spentJpy: 0, unknownCostCalls: 0 },
      investigation: { capJpy: caps.investigation, spentJpy: 0, unknownCostCalls: 0 },
    };
  }
  state(p: PoolName): Readonly<PoolState> {
    return this.pools[p];
  }
  remaining(p: PoolName): number {
    const s = this.pools[p];
    return Math.max(0, s.capJpy - s.spentJpy);
  }
  /** 最大費用を予約する。上限を超える見込みなら BudgetStop（呼び出さない）。予約額は精算まで計上する */
  reserve(p: PoolName, maxJpy: number): Ticket {
    if (!(maxJpy >= 0) || !Number.isFinite(maxJpy)) throw new BudgetStop(p, "最大費用が不正です");
    const s = this.pools[p];
    if (s.spentJpy + maxJpy > s.capJpy) throw new BudgetStop(p, `${p}の予算の上限に達する見込みのため実行しません（上限 ${s.capJpy}円・使用済み ${s.spentJpy.toFixed(2)}円・今回の最大 ${maxJpy.toFixed(2)}円）`);
    s.spentJpy += maxJpy;
    return { pool: p, maxJpy, settled: false };
  }
  /** 精算する。actual が null（費用不明）なら、予約額を使ったものとして残す */
  settle(t: Ticket, actualJpy: number | null): void {
    if (t.settled) return;
    t.settled = true;
    const s = this.pools[t.pool];
    // 費用が不明・不正（null・NaN・負の値）のときは、返金（過少計上）せず、予約額を使ったものとして残す
    if (actualJpy == null || !Number.isFinite(actualJpy) || actualJpy < 0) {
      s.unknownCostCalls += 1;
      return;
    }
    s.spentJpy -= t.maxJpy - Math.min(Math.max(actualJpy, 0), t.maxJpy * 10);
  }
  /** 呼び出しに失敗して使っていない場合の返却（失敗の費用が不明なら返却しない＝安全側） */
  release(t: Ticket, knownZero: boolean): void {
    if (t.settled) return;
    t.settled = true;
    if (knownZero) this.pools[t.pool].spentJpy -= t.maxJpy;
    else this.pools[t.pool].unknownCostCalls += 1;
  }
}
