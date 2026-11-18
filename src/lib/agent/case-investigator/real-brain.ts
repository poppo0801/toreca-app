/**
 * 実AI（Claude）を案件調査の頭脳として接続する（Stage 9H-2）。**実API。承認された範囲だけ**（real-gate.ts の関門・real-guard.ts の費用の台帳を通ること）。
 * AIが決めること: 次に調べる項目・検索語・調べる情報源・ページから読み取る項目・追加調査・終了。
 * AIが決められないこと: 上限・調査量の割り当て・アクセス範囲・DBへの書き込み（ツールの入力・出力に項目が無い／ツールが存在しない）。
 * システムプロンプトは engine.ts の INVESTIGATOR_SYSTEM（エンジンが渡す）。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicAgentLLM, type AnthropicLlmOptions } from "@/lib/agent/anthropic";
import type { AgentLLM } from "@/lib/agent/core";

export const FINISH_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", enum: ["sufficient", "no_improvement", "cannot_continue"], description: "sufficient=必要な情報が確認できた / no_improvement=これ以上調べても改善が見込めない / cannot_continue=取得制限などで続けられない" },
    note: { type: "string", description: "何を調べ、何が分かり、何が分からなかったかを短く" },
  },
  required: ["reason", "note"],
};
export const EMPTY_FINISH = { reason: "no_improvement", note: "終了の申告がないまま応答が終わりました（出力の途切れ・ツール未使用）" };

type Client = Pick<Anthropic, "messages">;

export function createInvestigatorBrain(client: Client, model: string, opts: Pick<AnthropicLlmOptions, "effort" | "maxOutputTokens"> = {}): AgentLLM {
  return new AnthropicAgentLLM(client, model, {
    effort: opts.effort ?? "low",
    maxOutputTokens: opts.maxOutputTokens ?? 3000,
    submit: { description: "調査を終えて結果を申告する。reason（sufficient / no_improvement / cannot_continue）と note。確認できなかった項目は不明のままでよい", schema: FINISH_SCHEMA, emptyOutput: EMPTY_FINISH },
  });
}
