// @vitest-environment node
/** 検索の部品（Phase 3 FOUNDATION_RECOVERY）: 偽のクライアントで、費用の計算・結果の取り出し・読み取り専用の呼び出し形を確認する（実APIは呼ばない） */
import { describe, expect, it, vi } from "vitest";
import { makeSearchTool } from "./research-search";
import { makeWebSearchProvider, parseWebSearchResults, webSearchCostJpy, WEB_SEARCH_JPY_PER_SEARCH } from "./web-search-provider";

const res = (over: Record<string, unknown> = {}) => ({
  content: [
    { type: "web_search_tool_result", tool_use_id: "t", content: [{ type: "web_search_result", url: "https://shop.example/a", title: "店A 抽選", page_age: "1日前", encrypted_content: "x" }, { type: "web_search_result", url: "http://insecure.example/b", title: "b", encrypted_content: "x" }] },
    { type: "text", text: "…", citations: [{ type: "web_search_result_location", url: "https://shop.example/a", cited_text: "応募期間 11月24日〜", title: "t", encrypted_index: "i" }] },
  ],
  usage: { input_tokens: 3000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } },
  ...over,
});

describe("検索の部品", () => {
  it("結果（題名・URL・引用の抜粋）を取り出し、費用は検索回数×料金＋トークンで計算する。エラー（配列でない）は空", () => {
    const hits = parseWebSearchResults(res() as never);
    expect(hits[0]).toEqual({ title: "店A 抽選", url: "https://shop.example/a", snippet: "応募期間 11月24日〜" });
    expect(parseWebSearchResults({ content: [{ type: "web_search_tool_result", tool_use_id: "t", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }] } as never)).toEqual([]);
    const c = webSearchCostJpy(res() as never, "claude-haiku-5-5");
    expect(c).toBeGreaterThan(WEB_SEARCH_JPY_PER_SEARCH);
    expect(c).toBeLessThan(WEB_SEARCH_JPY_PER_SEARCH + 1);
    expect(webSearchCostJpy(res({ usage: { input_tokens: 1000, output_tokens: 10 } }) as never, "claude-haiku-5-5")).toBeLessThan(0.1); // 検索0回（エラーは課金されない）ならトークンだけ
  });
  it("道具は web_search 1つだけ・1回の検索語につき最大1回・https の結果だけを makeSearchTool が通す。個人情報やURLを含む検索語は拒否する", async () => {
    const create = vi.fn(async () => res());
    const tool = makeSearchTool(makeWebSearchProvider({ messages: { create } } as never, "claude-haiku-5-5"));
    const ok = await tool("サンプル店 抽選 応募");
    expect(ok.ok && ok.hits.map((h) => h.url)).toEqual(["https://shop.example/a"]);
    const req = (create.mock.calls[0] as unknown as [{ tools: { type: string; name: string; max_uses: number }[] }])[0];
    expect(req.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]);
    expect(await tool("連絡 test@example.com")).toMatchObject({ ok: false });
    expect(await tool("https://x.example/a を調べて")).toMatchObject({ ok: false });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
