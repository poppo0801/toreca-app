/**
 * 自律探索の固定制御（Stage 9H-3P）。**AIは変更できない**（ツールの入力・出力に、上限・権限・アクセス範囲を変える項目は無い）。
 * 探索の自由度（何をどこでどう調べるか）はAIにあるが、無制限ではない: 回数・費用・時間・アクセス頻度に上限を設け、収穫が逓減したら止める。
 */
import type { AgentLimits } from "@/lib/agent/core";
import type { ThrottleOptions } from "@/lib/agent/collection-planner/throttle";
import type { DiscoveryMission } from "./types";

/** 1つのミッションの絶対上限（ミッションの種類による割り当ては、この範囲の中だけ） */
export const DISCOVERY_CAPS = Object.freeze({
  maxSteps: 30,
  maxSearches: 8,
  maxFetches: 16,
  maxCostJpy: 25,
  maxMs: 120_000,
  maxDuplicates: 3,
  maxRetries: 2,
  maxTokens: 500_000,
  perHostMax: 4,
  minIntervalMs: 1500,
  /** 取得・検索を続けても、新しい手がかり・新しい情報が増えない状態がこの回数続いたら、調査の価値が費用に見合わないとして継続を断る */
  stagnantLimit: 5,
  /** 費用がこの割合を超えても手がかり0件なら、継続を断る（探索を打ち切って未確認のまま記録する） */
  noLeadCostShare: 0.7,
});

/** セッション（複数ミッションの1回の実行）の上限 */
export const SESSION_CAPS = Object.freeze({ maxMissions: 6, maxCostJpy: 60 });

export interface MissionBudget {
  limits: AgentLimits;
  throttle: ThrottleOptions;
  stagnantLimit: number;
  noLeadCostShare: number;
  /** 割り当ての理由（記録用） */
  rationale: string;
}

/**
 * ミッションの種類に応じた割り当て。系列の網羅確認や新商品の起点は、探索の幅が要るので多め、周辺の確認は少なめ。
 * いずれも DISCOVERY_CAPS を超えない。実際にどこまで使うかは、AIが成果を見て決める（早く十分なら早く終わる）。
 */
export function allocateMission(m: DiscoveryMission, o: { real?: boolean } = {}): MissionBudget {
  const C = DISCOVERY_CAPS;
  const wide = m.trigger.kind === "chain" || m.trigger.kind === "product";
  const share = wide ? 1 : 0.6;
  const cut = (n: number) => Math.max(2, Math.min(n, Math.round(n * share)));
  const limits: AgentLimits = {
    maxSteps: cut(C.maxSteps),
    maxSearches: cut(C.maxSearches),
    maxFetches: cut(C.maxFetches),
    maxCostJpy: o.real ? Math.max(3, Math.round(C.maxCostJpy * share)) : C.maxCostJpy,
    maxMs: C.maxMs,
    maxDuplicates: C.maxDuplicates,
    maxRetries: C.maxRetries,
    maxTokens: C.maxTokens,
  };
  return {
    limits,
    throttle: { perHostMax: C.perHostMax, minIntervalMs: C.minIntervalMs },
    stagnantLimit: C.stagnantLimit,
    noLeadCostShare: C.noLeadCostShare,
    rationale: wide ? "系列・新商品を起点とするため、探索の幅（検索・取得）を多めに割り当て" : "既に見つかった抽選の周辺確認のため、割り当てを控えめに設定",
  };
}
