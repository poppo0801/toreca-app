/**
 * Anthropic API への接続（Stage 8D-2/8D-3）。**実API。承認前には使わない**（real-gate.ts の条件を満たさないと生成できない）。
 * 仕様の確認（2026-11-12、公式ドキュメント）:
 *  - Web検索は Messages API のサーバー側ツール（type: web_search_20250305 / 20260209 / 20260318、name: "web_search"）。claude-haiku-5-5 も対応モデル。
 *    組織で管理者が無効にしていない限り有効（無効なら 400 invalid_request_error）。max_uses で1ターンの検索数を制限（失敗した検索も数える）。
 *  - 料金: 1,000回あたり10ドル＋検索結果を読むトークン料金。エラーになった検索は課金されない。使用量は usage.server_tool_use.web_search_requests。
 *  - 結果ブロック web_search_result: url・title・page_age・encrypted_content（会話を続けるときは原本のまま戻す）。引用は text ブロックの citations（cited_text 最大150文字）。
 *  - stop_reason が pause_turn のときは、中断した assistant の応答をそのまま送り返して続ける。検索エラーは HTTP 200 で content がエラー1件のオブジェクト。
 *  - 基本版（20250305）は allowed_callers の既定が direct。動的フィルタリング版（20260209以降）はコード実行を使うため、ここでは基本版を使う。
 *  - Haiku 5.5: 思考は既定で適応型でオン、effort の既定は medium。ツール呼び出しの応答の thinking ブロックは次の要求へ原本のまま戻す（raw を保持して再送）。
 * 本番の ANTHROPIC_API_KEY は使わない。開発専用の AGENT_ANTHROPIC_API_KEY のみ（real-gate.ts）。
 * このモジュールは Anthropic クライアントを引数で受け取る（テストでは偽物を渡す）。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { estimateCostJpy, USD_JPY_ESTIMATE } from "@/lib/ai-cost";
import { TransientLlmError, type AgentLLM, type AgentMessage, type LlmStep, type ToolSpec } from "@/lib/agent/core";
import type { SearchHit, SearchOutcome, SearchProvider } from "@/lib/agent/store-location/tools";

export const SUBMIT_TOOL = "submit_findings";
/** Web検索の料金: 1,000回あたり10ドル（公式の料金ページ）。円は概算レート */
export const WEB_SEARCH_USD_PER_SEARCH = 10 / 1000;
export const WEB_SEARCH_JPY = WEB_SEARCH_USD_PER_SEARCH * USD_JPY_ESTIMATE;

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

export interface AnthropicLlmOptions {
  maxOutputTokens?: number;
  /** 思考の深さ。Haiku 5.5 の既定は medium。ここでは明示する（既定 medium） */
  effort?: "low" | "medium" | "high";
}

export class AnthropicAgentLLM implements AgentLLM {
  readonly name: string;
  constructor(private readonly client: Client, private readonly model: string, private readonly opts: AnthropicLlmOptions = {}) {
    this.name = `anthropic:${model}`;
  }

  async step({ system, messages, tools }: { system: string; messages: AgentMessage[]; tools: ToolSpec[] }): Promise<LlmStep> {
    const apiMessages = toApiMessages(messages);
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: this.opts.maxOutputTokens ?? 4000,
        system,
        messages: apiMessages,
        output_config: { effort: this.opts.effort ?? "medium" },
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
    if (res.stop_reason === "max_tokens") {
      // 出力が上限で途切れた（ツール呼び出しが不完全な可能性）。実行せずに終了させる
      return { kind: "final", output: { candidates: [], summary: "出力が上限に達したため中断" }, usage };
    }
    if (uses.length === 0) {
      // ツールも提出も無く終わった（説明だけ返した）
      return { kind: "final", output: { candidates: [], summary: res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").slice(0, 300) }, usage };
    }
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    return { kind: "tool_calls", calls: uses.map((u) => ({ id: u.id, name: u.name, input: (u.input ?? {}) as Record<string, unknown> })), text: text || undefined, raw: res.content as unknown[], usage };
  }
}

/** エージェントのメッセージを Messages API の形へ。assistant は応答の原本（raw: 思考ブロックを含む）があればそのまま戻す。ツール結果は直前の assistant の呼び出しにまとめて返す */
export function toApiMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      if (m.raw && m.raw.length > 0) {
        out.push({ role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] });
        continue;
      }
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
 * Anthropic の web_search（サーバー側ツール）による検索。1回の検索ごとに別の問い合わせを行い、結果のタイトル・URL・引用文を返す。
 * 費用: 実際の検索回数（usage.server_tool_use.web_search_requests）×検索料金＋この問い合わせのトークン料金。エラーの検索は課金されない。
 * 利用には、組織で Web 検索が無効になっていないこと（管理者が Console で無効化していると 400）。
 */
export class AnthropicWebSearch implements SearchProvider {
  readonly name = "anthropic-web-search";
  constructor(private readonly client: Client, private readonly model: string, private readonly opts: { allowedDomains?: string[]; blockedDomains?: string[] } = {}) {}
  async search(query: string): Promise<SearchOutcome> {
    const tool: Anthropic.WebSearchTool20250305 = { type: "web_search_20250305", name: "web_search", max_uses: 1 };
    if (this.opts.allowedDomains?.length) tool.allowed_domains = this.opts.allowedDomains;
    else if (this.opts.blockedDomains?.length) tool.blocked_domains = this.opts.blockedDomains;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: `次の検索語でWeb検索し、見つかったページを一覧で簡潔に答えてください（検索は1回だけ）: ${query}` }];
    let hits: SearchHit[] = [];
    let cost = 0;
    // pause_turn（長い検索の中断）のときは、応答をそのまま送り返して続ける（最大2回まで）
    for (let i = 0; i < 3; i++) {
      let res: Anthropic.Message;
      try {
        res = await this.client.messages.create({ model: this.model, max_tokens: 800, messages, tools: [tool], output_config: { effort: "low" } });
      } catch (e) {
        if (isTransientApiError(e)) throw new Error("検索サービスが一時的に利用できません");
        throw e;
      }
      cost += searchCostJpy(res, this.model);
      hits = mergeHits(hits, parseSearchResults(res));
      if (res.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });
    }
    return { hits: hits.slice(0, 8), costJpy: cost };
  }
}

/** 1回の応答の推定費用（円）: 実際の検索回数×検索料金＋トークン料金 */
export function searchCostJpy(res: Pick<Anthropic.Message, "usage">, model: string): number {
  const searches = res.usage.server_tool_use?.web_search_requests ?? 0;
  return searches * WEB_SEARCH_JPY + (estimateCostJpy(model, res.usage.input_tokens, res.usage.output_tokens) ?? 0);
}

const mergeHits = (a: SearchHit[], b: SearchHit[]): SearchHit[] => [...a, ...b.filter((x) => !a.some((y) => y.url === x.url))];

/** web_search_tool_result の結果＋ text ブロックの引用文（cited_text）から、タイトル・URL・要約を取り出す。エラー（content がオブジェクト）は空 */
export function parseSearchResults(res: Pick<Anthropic.Message, "content">): SearchHit[] {
  const hits: SearchHit[] = [];
  const cited = new Map<string, string>();
  for (const b of res.content) {
    if (b.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c.type === "web_search_result_location" && c.cited_text && !cited.has(c.url)) cited.set(c.url, c.cited_text);
    }
  }
  for (const b of res.content) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) {
        if (r.type === "web_search_result" && /^https?:\/\//.test(r.url)) hits.push({ title: r.title, url: r.url, snippet: cited.get(r.url) ?? (r.page_age ? `（${r.page_age}）` : "") });
      }
    }
  }
  return hits.slice(0, 8);
}
