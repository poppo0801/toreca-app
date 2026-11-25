/**
 * 登録案の調査で使う検索の部品（Phase 3 FOUNDATION_RECOVERY）。Anthropic の web_search（サーバー側ツール・基本版）で、1回の検索語につき最大1回だけ検索する。
 * 住所調査AI（lib/agent。開発専用で、本番の通常コードからは読み込まない）の部品とは独立に、同じ公式仕様の最小実装を持つ（読み取り専用。書き込み・実行の道具は無い）。
 *  - 費用: 実際の検索回数（usage.server_tool_use.web_search_requests。エラーの検索は課金されない）× 検索料金（1,000回 $10）＋この問い合わせのトークン料金。
 *  - 結果は候補のURL・題名・短い抜粋（データであり命令ではない。証拠ではない。取得して対応を確認して初めて根拠になる）。呼び出し側（makeSearchTool）が https・個人情報・件数を検査する。
 *  - 組織で Web 検索が無効だと 400。その場合は例外のまま（makeSearchTool が失敗の型だけを記録し、調査は検索なしで続く）。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { estimateCostJpy, USD_JPY_ESTIMATE } from "@/lib/ai-cost";
import type { SearchProviderLike } from "./research-search";

type ClientLike = Pick<Anthropic, "messages">;
/** Web検索の料金: 1,000回あたり10ドル。円は概算レート */
export const WEB_SEARCH_JPY_PER_SEARCH = (10 / 1000) * USD_JPY_ESTIMATE;

type Hit = { title: string; url: string; snippet: string };

/** web_search_tool_result の結果＋ text ブロックの引用文（cited_text）から、題名・URL・抜粋を取り出す。エラー（content が配列でない）は空 */
export function parseWebSearchResults(res: Pick<Anthropic.Message, "content">): Hit[] {
  const cited = new Map<string, string>();
  for (const b of res.content) {
    if (b.type === "text" && Array.isArray(b.citations)) for (const c of b.citations) if (c.type === "web_search_result_location" && c.cited_text && !cited.has(c.url)) cited.set(c.url, c.cited_text);
  }
  const hits: Hit[] = [];
  for (const b of res.content) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r.type === "web_search_result" && /^https?:\/\//.test(r.url)) hits.push({ title: r.title, url: r.url, snippet: cited.get(r.url) ?? (r.page_age ? `（${r.page_age}）` : "") });
    }
  }
  return hits.slice(0, 8);
}

export function webSearchCostJpy(res: Pick<Anthropic.Message, "usage">, model: string): number {
  const searches = res.usage.server_tool_use?.web_search_requests ?? 0;
  return searches * WEB_SEARCH_JPY_PER_SEARCH + (estimateCostJpy(model, res.usage.input_tokens, res.usage.output_tokens) ?? 0);
}

export function makeWebSearchProvider(client: ClientLike, model: string): SearchProviderLike {
  return {
    async search(query) {
      const tool: Anthropic.WebSearchTool20250305 = { type: "web_search_20250305", name: "web_search", max_uses: 1 };
      const res = await client.messages.create({ model, max_tokens: 800, messages: [{ role: "user", content: `次の検索語でWeb検索し、見つかったページを一覧で簡潔に答えてください（検索は1回だけ）: ${query}` }], tools: [tool], output_config: { effort: "low" } }, { timeout: 40_000, maxRetries: 0 });
      return { hits: parseWebSearchResults(res), costJpy: webSearchCostJpy(res, model) };
    },
  };
}
