/**
 * 店舗所在地エージェントのツール（Stage 8D-2）。すべて読み取り専用。検索・取得・地図・DBの実体は呼び出し側が差し込む（交換可能）。
 * 新しいツールの追加方法: AgentTool を作り（access は read_internal / read_external のみ）、buildStoreLocationTools に足す。
 * 書き込み・SQL・実行に当たるツールは ToolRegistry.register が拒否する。
 */
import { type AgentTool, type ToolOutput, ToolRegistry } from "@/lib/agent/core";
import { normalizeForMatch, type GeoHit } from "@/lib/geocode";
import { domainOf, type StoreTarget } from "@/lib/agent/store-location/verify";

// ---------------------------------------------------------------- 差し替え可能な部品
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}
/** Web検索。実装は交換可能（Anthropic の web_search ツール／外部の検索API／モック） */
export interface SearchProvider {
  readonly name: string;
  search(query: string): Promise<SearchHit[]>;
}
export type FetchedPage = { ok: true; url: string; finalUrl: string; title: string; text: string } | { ok: false; message: string };
/** ページ本文の取得。実装は SSRF 対策つきの安全な取得（本番側）か、モック */
export interface PageFetcher {
  fetchPage(url: string): Promise<FetchedPage>;
}
export interface PastResearch {
  status: string;
  address: string | null;
  confidence: number;
  researchedAt: string;
}
export interface StoreToolDeps {
  store: StoreTarget;
  /** 登録済みの住所（あれば）。調査結果は既存の住所を上書きしない */
  existingAddress: string | null;
  search: SearchProvider;
  fetcher: PageFetcher;
  geocode: (query: string) => Promise<GeoHit[] | null>;
  past: () => Promise<PastResearch[]>;
  /** 1回の検索あたりの概算費用（円）。実際の請求額とは異なる推定値 */
  searchCostJpy?: number;
}

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** 取得してよいURL: 検索結果に出たもの、または登録済みの公式サイト。AI（や外部文面）が作った任意のURLは取得しない */
export function buildStoreLocationTools(deps: StoreToolDeps): ToolRegistry {
  const allowed = new Set<string>(deps.store.knownDomains.map((d) => `https://${d}`));
  const registry = new ToolRegistry();

  const webSearch: AgentTool = {
    name: "web_search",
    description: "Webを検索して、ページのタイトル・URL・要約を返す。検索語は店舗名・系列名・住所・公式サイト・店舗一覧などを工夫して変えてよい（回数に上限がある）",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "検索語" } }, required: ["query"] },
    access: "read_external",
    consumes: "search",
    costJpy: deps.searchCostJpy ?? 1.5,
    async run(input) {
      const query = str(input.query, 120);
      if (!query) throw new Error("検索語が空です");
      const hits = (await deps.search.search(query)).slice(0, 8);
      for (const h of hits) allowed.add(h.url);
      const content = hits.length ? hits.map((h, i) => `${i + 1}. ${h.title} | ${h.url} | ${h.snippet}`).join("\n") : "（該当なし）";
      return { content, untrusted: true, data: { query, hits } } satisfies ToolOutput;
    },
  };

  const fetchPage: AgentTool = {
    name: "fetch_page",
    description: "検索結果に出たページ（または登録済みの公式サイト）の本文を取得する。ログインが必要なページや、ロボット制限のあるページは取得できない",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    access: "read_external",
    consumes: "fetch",
    async run(input) {
      const url = str(input.url, 500);
      if (![...allowed].some((a) => a === url || (url.startsWith(a) && a.split("/").length <= 3))) {
        throw new Error("検索結果に出ていないURLは取得しません");
      }
      const r = await deps.fetcher.fetchPage(url);
      if (!r.ok) throw new Error(r.message);
      const text = r.text.slice(0, 20_000);
      return { content: `${r.title}\n${text.slice(0, 5_000)}`, untrusted: true, data: { url, finalUrl: r.finalUrl, title: r.title, text, domain: domainOf(r.finalUrl) } };
    },
  };

  const compare: AgentTool = {
    name: "compare_addresses",
    description: "2つの住所が同じ場所を指すか（全角半角・丁目番地の表記ゆれを吸収して）比較する",
    inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
    access: "read_internal",
    async run(input) {
      const a = normalizeForMatch(str(input.a));
      const b = normalizeForMatch(str(input.b));
      const same = !!a && !!b && a === b;
      const prefix = !same && !!a && !!b && (a.startsWith(b) || b.startsWith(a));
      return { content: same ? "同じ住所" : prefix ? "一方がもう一方より細かい表記（同じ場所の可能性）" : "異なる住所" };
    },
  };

  const readStore: AgentTool = {
    name: "read_store",
    description: "調査対象の店舗の登録情報（系列名・店舗名・都道府県・同じ系列の他店舗名・登録済みの住所）を読む（読み取り専用）",
    inputSchema: { type: "object", properties: {} },
    access: "read_internal",
    async run() {
      const s = deps.store;
      return {
        content: JSON.stringify({ 系列: s.chain, 店舗: s.name, 都道府県: s.prefecture || "不明", 同じ系列の他店舗: s.siblingNames.slice(0, 20), 登録済みの住所: deps.existingAddress ?? "なし", 既知の公式ドメイン: s.knownDomains }),
      };
    },
  };

  const past: AgentTool = {
    name: "past_research",
    description: "この店舗について過去に行った調査結果（状態・住所・信頼度・日時）を読む。再調査の無駄を減らす",
    inputSchema: { type: "object", properties: {} },
    access: "read_internal",
    async run() {
      const rows = await deps.past();
      return { content: rows.length ? rows.map((r) => `${r.researchedAt.slice(0, 10)} ${r.status} ${r.address ?? "-"} 信頼度${r.confidence}`).join("\n") : "過去の調査はありません" };
    },
  };

  const geocode: AgentTool = {
    name: "geocode_address",
    description: "住所を国土地理院の住所検索で調べ、緯度経度の候補を返す（無料）。住所の実在確認に使える",
    inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
    access: "read_external",
    async run(input) {
      const q = str(input.address);
      const hits = await deps.geocode(q);
      if (!hits) throw new Error("住所検索を利用できませんでした");
      return { content: hits.length ? hits.slice(0, 5).map((h) => `${h.title} (${h.lat.toFixed(4)}, ${h.lng.toFixed(4)})`).join("\n") : "該当なし" };
    },
  };

  return registry.register(readStore).register(past).register(webSearch).register(fetchPage).register(compare).register(geocode);
}
