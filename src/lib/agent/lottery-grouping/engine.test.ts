// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AnthropicAgentLLM } from "@/lib/agent/anthropic";
import { GROUPING_SUBMIT, parseGroupingProposal } from "@/lib/agent/lottery-grouping/proposal";
import { createGroupingLlm } from "@/lib/server/agent/lottery-grouping-engine";

/** 実APIを使わない（偽のクライアント）。実APIの関門・提出ツールの差し替え・出力の扱いの検証 */
const fakeClient = (reply: unknown) => {
  const seen: { tools?: { name: string; input_schema: unknown }[] } = {};
  return {
    seen,
    client: {
      messages: {
        create: async (req: { tools: { name: string; input_schema: unknown }[] }) => {
          seen.tools = req.tools;
          return reply;
        },
      },
    } as never,
  };
};
const usage = { input_tokens: 100, output_tokens: 50 };
const opts = { submit: { description: GROUPING_SUBMIT.description, schema: GROUPING_SUBMIT.schema, emptyOutput: GROUPING_SUBMIT.emptyOutput } };

describe("グループ判定の実API接続（偽のクライアントで検証。実APIは呼ばない）", () => {
  it("提出ツールは、グループ判定用の定義に差し替わる（店舗所在地用のものは混ざらない）", async () => {
    const f = fakeClient({ content: [{ type: "tool_use", id: "t1", name: "submit_findings", input: { action: "single", rationale: "x" } }], stop_reason: "tool_use", usage });
    const llm = new AnthropicAgentLLM(f.client, "claude-haiku-5-5", opts);
    const step = await llm.step({ system: "s", messages: [{ role: "user", text: "t" }], tools: [{ name: "get_subject", description: "d", inputSchema: { type: "object", properties: {} } }] });
    expect(step.kind).toBe("final");
    expect(parseGroupingProposal((step as { output: unknown }).output)?.action).toBe("single");
    const submit = f.seen.tools!.find((t) => t.name === "submit_findings")!;
    expect(JSON.stringify(submit.input_schema)).toContain("memberIds");
    expect(JSON.stringify(submit.input_schema)).not.toContain("sourceUrl");
  });
  it("出力が途切れた・ツールも提出も無い場合は、保留として扱う（まとめない）", async () => {
    for (const reply of [{ content: [{ type: "text", text: "..." }], stop_reason: "max_tokens", usage }, { content: [{ type: "text", text: "説明だけ" }], stop_reason: "end_turn", usage }]) {
      const llm = new AnthropicAgentLLM(fakeClient(reply).client, "claude-haiku-5-5", opts);
      const step = await llm.step({ system: "s", messages: [{ role: "user", text: "t" }], tools: [] });
      expect(parseGroupingProposal((step as { output: unknown }).output)?.action).toBe("hold");
    }
  });
  it("既定は店舗所在地用の提出（8D の動作は変わらない）", async () => {
    const f = fakeClient({ content: [{ type: "tool_use", id: "t1", name: "submit_findings", input: { candidates: [] } }], stop_reason: "tool_use", usage });
    await new AnthropicAgentLLM(f.client, "claude-haiku-5-5").step({ system: "s", messages: [{ role: "user", text: "t" }], tools: [] });
    expect(JSON.stringify(f.seen.tools!.find((t) => t.name === "submit_findings")!.input_schema)).toContain("sourceUrl");
  });
  it("実APIの関門: 条件がそろわない限りモック。すべてそろっても、本番のキーと同じ値・確認なし・回数超過は拒否", () => {
    const ok = { TOREMANE_ENV: "local", AGENT_REAL_API: "allow", AGENT_ANTHROPIC_API_KEY: "sk-dev-aaaa", AGENT_MAX_COST_JPY_PER_RUN: "5", AGENT_MAX_RUNS_PER_DAY: "30", GROUPING_REAL_CONFIRM: "yes" };
    const made: string[] = [];
    const real = createGroupingLlm(ok, 0, (k) => (made.push(k), fakeClient({}).client));
    expect(real.real).toBe(true);
    expect(real.llm.name).toContain("anthropic:");
    expect(made).toEqual(["sk-dev-aaaa"]);
    const mock = (env: Record<string, string>, runs = 0) => createGroupingLlm(env, runs, () => { throw new Error("実APIのクライアントを作ってはいけない"); });
    expect(mock({ ...ok, GROUPING_REAL_CONFIRM: "" }).real).toBe(false);
    expect(mock({ ...ok, ANTHROPIC_API_KEY: "sk-dev-aaaa" }).real).toBe(false); // 本番のキーと同じ
    expect(mock({ ...ok, AGENT_REAL_API: "" }).real).toBe(false);
    expect(mock({ ...ok, TOREMANE_ENV: "production" }).real).toBe(false);
    expect(mock(ok, 30).real).toBe(false); // 1日の回数上限
    expect(mock({}).note).toContain("開発環境");
  });
});
