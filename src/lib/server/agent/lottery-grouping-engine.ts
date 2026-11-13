import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { AgentLLM } from "@/lib/agent/core";
import { AnthropicAgentLLM } from "@/lib/agent/anthropic";
import { MockGroupingBrain } from "@/lib/agent/lottery-grouping/mock";
import { GROUPING_SUBMIT } from "@/lib/agent/lottery-grouping/proposal";
import { checkRealApi } from "@/lib/agent/real-gate";

/**
 * グループ判定に使うAIの選択（Stage 8F）。既定はモック（実APIは使わない・費用なし）。
 * 実APIは、8D と同じ関門（checkRealApi）をすべて満たしたときだけ: 開発環境（TOREMANE_ENV=local）・AGENT_REAL_API=allow・開発専用キー（本番のキーと別）・
 * 費用上限・1日の実行回数上限・実行ごとの確認（GROUPING_REAL_CONFIRM=yes）。**費用と条件を報告して利用者が承認するまで、実APIは有効にしない。**
 */
export interface GroupingEngine {
  llm: AgentLLM;
  real: boolean;
  /** 実APIを使わない理由（モックのとき） */
  note: string;
}
export function createGroupingLlm(env: Record<string, string | undefined>, runsToday = 0, makeClient: (apiKey: string) => Pick<Anthropic, "messages"> = (k) => new Anthropic({ apiKey: k })): GroupingEngine {
  const gate = checkRealApi({ env, confirm: env.GROUPING_REAL_CONFIRM === "yes", runsToday });
  if (!gate.ok) return { llm: new MockGroupingBrain("careful"), real: false, note: gate.reason };
  return { llm: new AnthropicAgentLLM(makeClient(gate.apiKey), gate.model, { submit: { description: GROUPING_SUBMIT.description, schema: GROUPING_SUBMIT.schema, emptyOutput: GROUPING_SUBMIT.emptyOutput } }), real: true, note: "" };
}

/**
 * 情報源の取得部品（Stage 8F-4）。開発環境（TOREMANE_ENV=local）で、GROUPING_FETCH=allow のときだけ作る（既定は取得しない）。
 * 取得は既存の安全な取得（SSRF対策・robots.txt の尊重・サイズ/時間の上限・取得間隔）で、AIが取得できるのは、抽選に登録された情報源URLだけ。
 * 本番（Vercel）では作らない。
 */
export async function createGroupingFetcher(env: Record<string, string | undefined>): Promise<import("@/lib/agent/store-location/tools").PageFetcher | undefined> {
  if (env.TOREMANE_ENV !== "local" || env.GROUPING_FETCH !== "allow") return undefined;
  const { SafePageFetcher } = await import("@/lib/server/agent/real-providers");
  return new SafePageFetcher();
}
