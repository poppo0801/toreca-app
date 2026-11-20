/**
 * 統合AI判断のモデル境界（Stage 10E）。**実AIの呼び出しはここを実装する側が行う。10Eでは実装していない（承認制）**。
 * テストでは台本のモデル（`ScriptedModel`・test double）を使う。台本の答えは「実AIの精度の証明」ではない（経路・検証・安全・費用制御の検証用）。
 */
import type { JudgmentInput, NextAction } from "./contract";

export interface ModelCall<T> {
  raw: T;
  /** 費用（円）。不明は null（0円とみなさない） */
  costJpy: number | null;
}

export interface PlanRequest {
  question: string;
  /** これまでに実行した行動（同じ行動を繰り返さないため） */
  attempted: string[];
  blockedHosts: string[];
  input: JudgmentInput;
}

export type PlanAnswer = NextAction | { kind: "give_up"; reason: string };

export interface JudgmentModel {
  id: string;
  promptVersion: string;
  /** 1回の判断・計画の最大費用（予約に使う。入力の大きさから見積もる） */
  maxCostJpy(input: JudgmentInput): number;
  judge(input: JudgmentInput): Promise<ModelCall<unknown>>;
  planAction(req: PlanRequest): Promise<ModelCall<unknown>>;
}

/** 入力の大きさからの保守的な費用見積もり（円）。実AI接続時は `ai-cost` の単価で置き換える */
export function estimateMaxCostJpy(input: JudgmentInput, perThousandCharsJpy = 0.05, outputReserveJpy = 1): number {
  const chars = JSON.stringify(input).length;
  return Math.round(((chars / 1000) * perThousandCharsJpy + outputReserveJpy) * 100) / 100;
}

/**
 * 台本のモデル（テスト用）。judge は与えられた関数の返す値をそのまま返す（検証層・再判断・費用制御・失敗処理を検査するため）。
 * 関数は入力（再判断のときは feedback つき）を受け取れる。
 */
export class ScriptedModel implements JudgmentModel {
  id = "scripted-test-double";
  promptVersion = "test";
  calls = 0;
  planCalls = 0;
  constructor(
    private judgeFn: (input: JudgmentInput, n: number) => ModelCall<unknown> | Promise<ModelCall<unknown>>,
    private planFn: (req: PlanRequest, n: number) => ModelCall<unknown> | Promise<ModelCall<unknown>> = () => ({ raw: { kind: "give_up", reason: "計画なし" }, costJpy: 0 }),
    private maxCost = 1,
  ) {}
  maxCostJpy(): number {
    return this.maxCost;
  }
  async judge(input: JudgmentInput): Promise<ModelCall<unknown>> {
    return this.judgeFn(input, this.calls++);
  }
  async planAction(req: PlanRequest): Promise<ModelCall<unknown>> {
    return this.planFn(req, this.planCalls++);
  }
}
