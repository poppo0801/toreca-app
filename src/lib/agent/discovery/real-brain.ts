/**
 * 実AI（Claude）を自律探索の頭脳として接続する部品（Stage 9H-3P）。**この段階では呼び出していない**（実API・有料。次のステージで、費用と条件を報告して承認を得てから）。
 * 実行するときは real-gate.ts の関門と RealRunGuard（費用の台帳）を通すこと。本番のAPIキーは使わない（開発専用キーのみ）。
 * AIが決められるのは、調べる対象・検索語・情報源・記録する手がかり・終了。上限・アクセス範囲・DB書き込みは、ツールの入力にも出力にも存在しない。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicAgentLLM, type AnthropicLlmOptions } from "@/lib/agent/anthropic";
import type { AgentLLM } from "@/lib/agent/core";
import { FINISH_SCHEMA } from "./engine";

export const EMPTY_DISCOVERY_FINISH = { reason: "no_improvement", note: "終了の申告がないまま応答が終わりました（出力の途切れ・ツール未使用）", unconfirmed: [] };

export function createDiscoveryBrain(client: Pick<Anthropic, "messages">, model: string, opts: Pick<AnthropicLlmOptions, "effort" | "maxOutputTokens"> = {}): AgentLLM {
  return new AnthropicAgentLLM(client, model, {
    effort: opts.effort ?? "low",
    maxOutputTokens: opts.maxOutputTokens ?? 3000,
    submit: { description: "調査を終えて結果を提出する。reason・note・unconfirmed（確認できなかった対象。開催なしの意味ではない）", schema: FINISH_SCHEMA, emptyOutput: EMPTY_DISCOVERY_FINISH },
  });
}
