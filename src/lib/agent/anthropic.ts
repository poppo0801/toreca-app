/**
 * Anthropic API への接続（Stage 8D-2）。**実API。承認前には使わない**（real-gate.ts の条件を満たさないと生成できない）。
 *  - AnthropicAgentLLM: Messages API のツール利用（クライアントツール＋提出用ツール submit_findings）でエージェントの次の手を決める。
 *  - AnthropicWebSearch: Anthropic の web_search（サーバー側ツール）で検索する SearchProvider。
 * 本番の ANTHROPIC_API_KEY は使わない。開発専用の AGENT_ANTHROPIC_API_KEY のみ（real-gate.ts）。
 * このモジュールは Anthropic クライアントを引数で受け取る（テストでは偽物を渡す。実際のAPIへの接続は、このStageでは行っていない）。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { estimateCostJpy } from "@/lib/ai-cost";
import { TransientLlmError, type AgentLLM, type AgentMessage, type LlmStep, type ToolSpec } from "@/lib/agent/core";
import type { SearchHit, SearchProvider } from "@/lib/agent/store-location/tools";

export const SUBMIT_TOOL = "submit_findings";
const submitTool = (schema: Record<string, unknown>): Anthropic.Tool => ({
  name: SUBMIT_TOOL,
  description: "調査の結果を提出して終了する。候補（address・sourceUrl・quote）を最大5件。見つからなければ candidates を空にする",
  input_schema: schema as Anthropic.Tool["input_schema"],
});
export const SUBMIT_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: { type: "object", properties: { address: { type: "string" }, sourceUrl: { type: "string" }, quote: { type: "string" }, closureHint: { type: "string" } }, required: ["address", "sourceUrl", "quote"] },
    },
    summary: { type: "string" },
  },
  required: ["candidates"],
};

type Client = Pick<Anthropic, "messages">;

/** API の一時的な障害（混雑・レート制限・5xx・通信）か */
export function isTransientApiError(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (status === 429 || status === 529 || (typeof status === "number" && status >= 500)) return true;
  const name = (e as { name?: string })?.name ?? "";
  return /Timeout|Connection|Network/i.test(name) || /ECONNRESET|ETIMEDOUT|fetch failed/i.test((e as Error)?.message ?? "");
}

export class AnthropicAgentLLM implements AgentLLM {
  readonly name: string;
  constructor(private readonly client: Client, private readonly model: string, private readonly maxOutputTokens = 1500) {
    this.name = `anthropic:${model}`;
  }

  async step({ system, messages, tools }: { system: string; messages: AgentMessage[]; tools: ToolSpec[] }): Promise<LlmStep> {
    const apiMessages = toApiMessages(messages);
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxOutputTokens,
        system,
        messages: apiMessages,
        tools: [...tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool["input_schema"] })), submitTool(SUBMIT_SCHEMA)],
      });
    } catch (e) {
      if (isTransientApiError(e)) throw new TransientLlmError((e as Error).message ?? "一時的なAPIエラー");
      throw e;
    }
    const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, costJpy: estimateCostJpy(this.model, res.usage.input_tokens, res.usage.output_tokens) ?? 0 };
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const submit = uses.find((u) => u.name === SUBMIT_TOOL);
    if (submit) return { kind: "final", output: submit.input, usage };
    if (uses.length === 0) {
      // ツールも提出も無く終わった（説明だけ返した）。提出を促す
      return { kind: "final", output: { candidates: [], summary: res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").slice(0, 300) }, usage };
    }
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    return { kind: "tool_calls", calls: uses.map((u) => ({ id: u.id, name: u.name, input: (u.input ?? {}) as Record<string, unknown> })), text: text || undefined, usage };
  }
}

/** エージェントのメッセージを Messages API の形へ。ツール結果は直前の assistant のツール呼び出しにまとめて返す */
export function toApiMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const c of m.calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      out.push({ role: "assistant", content });
    } else {
      const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: m.callId, content: m.content, is_error: m.isError };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) (last.content as Anthropic.ContentBlockParam[]).push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

/**
 * Anthropic の web_search（サーバー側ツール）による検索。1回の検索ごとに別の問い合わせを行い、結果のタイトル・URLを返す。
 * 利用には、Anthropic Console（組織設定）で Web 検索の有効化が必要。料金は検索回数に応じた従量課金＋トークン料金（金額は公式の料金ページで確認。未確認）。
 * 検索の上限・ドメイン制限は max_uses・allowed_domains で指定できる。
 */
export class AnthropicWebSearch implements SearchProvider {
  readonly name = "anthropic-web-search";
  constructor(private readonly client: Client, private readonly model: string) {}
  async search(query: string): Promise<SearchHit[]> {
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: 400,
        messages: [{ role: "user", content: `次の検索語でWeb検索し、結果を確認してください: ${query}` }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      });
    } catch (e) {
      if (isTransientApiError(e)) throw new Error("検索サービスが一時的に利用できません");
      throw e;
    }
    return parseSearchResults(res);
  }
}

export function parseSearchResults(res: Pick<Anthropic.Message, "content">): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const b of res.content) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r.type === "web_search_result" && /^https?:\/\//.test(r.url)) hits.push({ title: r.title, url: r.url, snippet: r.page_age ? `（${r.page_age}）` : "" });
    }
  }
  return hits.slice(0, 8);
}
