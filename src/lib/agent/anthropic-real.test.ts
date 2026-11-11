import { describe, expect, it } from "vitest";
import { AnthropicAgentLLM, AnthropicWebSearch, parseSearchResults, searchCostJpy, toApiMessages, WEB_SEARCH_JPY } from "@/lib/agent/anthropic";
import { runAgent, ToolRegistry } from "@/lib/agent/core";
import { CachedFetcher, CachedSearch, excerptForAddress, MemoryCache, buildStoreLocationTools } from "@/lib/agent/store-location/tools";

const res = (content: unknown[], usage: Record<string, unknown> = { input_tokens: 1000, output_tokens: 100 }, stop_reason = "end_turn") => ({ content, usage, stop_reason }) as never;

describe("Anthropic Web検索・費用の仕様への適合（偽のクライアント。実APIには接続しない）", () => {
  it("検索費用: 実際の検索回数×10ドル/1000回（円換算）＋トークン料金。エラーの検索（0回）は検索料金なし", () => {
    expect(WEB_SEARCH_JPY).toBeCloseTo(1.5, 5);
    const one = searchCostJpy({ usage: { input_tokens: 10_000, output_tokens: 500, server_tool_use: { web_search_requests: 1 } } } as never, "claude-haiku-5-5");
    expect(one).toBeCloseTo(1.5 + ((10_000 * 0.1 + 500 * 0.5) / 1_000_000) * 150, 5);
    const err = searchCostJpy({ usage: { input_tokens: 10_000, output_tokens: 500, server_tool_use: { web_search_requests: 0 } } } as never, "claude-haiku-5-5");
    expect(err).toBeLessThan(0.5);
  });
  it("検索結果と、本文の引用（cited_text）を要約として取り込む。エラー（content がオブジェクト）は空", () => {
    const hits = parseSearchResults({
      content: [
        { type: "text", text: "x", citations: [{ type: "web_search_result_location", url: "https://a.test/shops", cited_text: "テスト書店 駅前店 東京都…", title: "A", encrypted_index: "e" }] },
        { type: "web_search_tool_result", tool_use_id: "s", content: [{ type: "web_search_result", url: "https://a.test/shops", title: "A", page_age: null, encrypted_content: "" }, { type: "web_search_result", url: "https://b.test/", title: "B", page_age: "2026-10-01", encrypted_content: "" }] },
      ],
    } as never);
    expect(hits[0].snippet).toContain("テスト書店");
    expect(hits[1].snippet).toBe("（2026-10-01）");
    expect(parseSearchResults({ content: [{ type: "web_search_tool_result", tool_use_id: "s", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }] } as never)).toEqual([]);
  });
  it("検索: 費用は実際の使用量から計算し、pause_turn は応答を送り返して続け、最大3回で止まる", async () => {
    const calls: { messages: unknown[] }[] = [];
    const client = {
      messages: {
        create: async (p: { messages: unknown[] }) => {
          calls.push({ messages: [...p.messages] });
          return calls.length === 1
            ? res([{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }], { input_tokens: 500, output_tokens: 50, server_tool_use: { web_search_requests: 1 } }, "pause_turn")
            : res([{ type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a.test/", title: "A", page_age: null, encrypted_content: "" }] }], { input_tokens: 800, output_tokens: 60, server_tool_use: { web_search_requests: 0 } });
        },
      },
    };
    const out = await new AnthropicWebSearch(client as never, "claude-haiku-5-5").search("q");
    expect(calls).toHaveLength(2);
    expect(calls[1].messages).toHaveLength(2); // 中断した応答をそのまま戻している
    expect(out.hits).toHaveLength(1);
    expect(out.costJpy!).toBeGreaterThan(1.5);
    let n = 0;
    const stuck = { messages: { create: async () => (n++, res([], { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } }, "pause_turn")) } };
    await new AnthropicWebSearch(stuck as never, "m").search("q");
    expect(n).toBe(3); // 無限に続けない
  });
  it("ドメイン制限（allowed_domains）を指定でき、max_uses は1", async () => {
    const seen: { tools: Record<string, unknown>[] }[] = [];
    const client = { messages: { create: async (p: never) => (seen.push(p), res([])) } };
    await new AnthropicWebSearch(client as never, "m", { allowedDomains: ["example.test"] }).search("q");
    expect(seen[0].tools[0]).toMatchObject({ max_uses: 1, allowed_domains: ["example.test"] });
  });
  it("エージェントの要求: effort を明示し、アシスタントの応答の原本（思考ブロック）を次の要求へそのまま戻す", async () => {
    const sent: { messages: { role: string; content: unknown }[]; output_config?: unknown; max_tokens: number }[] = [];
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const client = {
      messages: {
        create: async (p: never) => {
          sent.push(p);
          return sent.length === 1 ? res([thinking, { type: "tool_use", id: "t1", name: "read_store", input: {} }]) : res([{ type: "tool_use", id: "t2", name: "submit_findings", input: { candidates: [] } }]);
        },
      },
    };
    const reg = new ToolRegistry().register({ name: "read_store", description: "d", inputSchema: { type: "object", properties: {} }, access: "read_internal", run: async () => ({ content: "ok" }) });
    const run = await runAgent({ llm: new AnthropicAgentLLM(client as never, "claude-haiku-5-5", { effort: "low" }), tools: reg, system: "s", task: "t" });
    expect(run.status).toBe("completed");
    expect(sent[0].output_config).toEqual({ effort: "low" });
    expect(sent[0].max_tokens).toBeGreaterThanOrEqual(4000);
    const assistant = sent[1].messages.find((m) => m.role === "assistant")!;
    expect((assistant.content as unknown[])[0]).toEqual(thinking); // 思考ブロックを原本のまま
  });
  it("出力が上限で途切れた応答は、ツールを実行せずに終了する", async () => {
    const client = { messages: { create: async () => res([{ type: "tool_use", id: "t", name: "read_store", input: {} }], { input_tokens: 1, output_tokens: 4000 }, "max_tokens") } };
    const step = await new AnthropicAgentLLM(client as never, "m").step({ system: "", messages: [], tools: [] });
    expect(step.kind).toBe("final");
  });
  it("raw が無い場合（モック等）は text と tool_use から組み立てる", () => {
    const api = toApiMessages([{ role: "user", text: "t" }, { role: "assistant", text: "調べる", calls: [{ id: "a", name: "x", input: {} }] }]);
    expect((api[1].content as { type: string }[]).map((b) => b.type)).toEqual(["text", "tool_use"]);
  });
});

describe("キャッシュ・本文の要約（無駄なAPI利用・トークンを減らす）", () => {
  it("同じ検索語は2回目から保存済みの結果を使い、費用がかからない。空の結果はキャッシュしない", async () => {
    let n = 0;
    const inner = { name: "i", search: async (q: string) => (n++, q === "none" ? [] : [{ title: "t", url: "https://a.test", snippet: "s" }]) };
    const c = new CachedSearch(inner, new MemoryCache());
    expect(await c.search("テスト書店　駅前")).not.toMatchObject({ cached: true });
    expect(await c.search("テスト書店 駅前")).toMatchObject({ cached: true, costJpy: 0 }); // 空白の違いは同じ検索語
    await c.search("none");
    await c.search("none");
    expect(n).toBe(3);
  });
  it("同じページは再取得しない。失敗はキャッシュしない。期限切れで再取得", async () => {
    let n = 0;
    const inner = { fetchPage: async (u: string) => (n++, u.includes("bad") ? { ok: false as const, message: "x" } : { ok: true as const, url: u, finalUrl: u, title: "T", text: "本文" }) };
    let t = 0;
    const f = new CachedFetcher(inner, new MemoryCache(1000, () => t));
    await f.fetchPage("https://a.test/1");
    const hit = await f.fetchPage("https://a.test/1");
    expect((hit as { cached?: boolean }).cached).toBe(true);
    await f.fetchPage("https://a.test/bad");
    await f.fetchPage("https://a.test/bad");
    expect(n).toBe(3);
    t = 5000;
    await f.fetchPage("https://a.test/1");
    expect(n).toBe(4);
  });
  it("長いページは、冒頭と店舗名・住所らしい行（前後）を優先して抜き出し、上限内に収める", () => {
    const filler = Array.from({ length: 400 }, (_, i) => `関係のない行${i} ${"あ".repeat(20)}`);
    const text = [...filler.slice(0, 200), "テスト書店 駅前店　所在地：東京都架空区駅前1-2-3", ...filler.slice(200)].join("\n");
    const ex = excerptForAddress(text, "駅前", 1500);
    expect(ex.length).toBeLessThanOrEqual(1500);
    expect(ex).toContain("東京都架空区駅前1-2-3");
    expect(excerptForAddress("短い本文", "駅前")).toBe("短い本文");
  });
  it("fetch_page: 取得したページと同じサイト内のリンクは次に取得できる。別サイトのリンクは取得できない", async () => {
    const deps = {
      store: { chain: "テスト書店", name: "テスト書店 駅前店", prefecture: "東京都", knownDomains: ["test-bookstore.test"], siblingNames: [] },
      existingAddress: null,
      search: { name: "s", search: async () => [] },
      geocode: async () => [],
      past: async () => [],
      fetcher: { fetchPage: async (url: string) => ({ ok: true as const, url, finalUrl: url, title: "T", text: "本文", links: [{ text: "店舗一覧", href: "https://test-bookstore.test/shops" }, { text: "外部", href: "https://evil.test/?k=1" }] }) },
    };
    const t = buildStoreLocationTools(deps).get("fetch_page")!;
    const r = await t.run({ url: "https://test-bookstore.test/" }, {} as never);
    expect(r.content).toContain("店舗一覧 → https://test-bookstore.test/shops");
    expect(r.content).not.toContain("evil.test");
    await expect(t.run({ url: "https://evil.test/?k=1" }, {} as never)).rejects.toThrow(/検索結果に出ていない/);
  });
});
