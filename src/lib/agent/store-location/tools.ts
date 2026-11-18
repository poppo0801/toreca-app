/**
 * 店舗所在地エージェントのツール（Stage 8D-2/8D-3）。すべて読み取り専用。検索・取得・地図・DBの実体は呼び出し側が差し込む（交換可能）。
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
/** 検索の結果。実APIの検索は、検索料金＋検索結果を読むトークン料金（extraCostJpy）を報告する。キャッシュから返したときは cached=true（費用なし） */
export interface SearchOutcome {
  hits: SearchHit[];
  /** この検索に実際にかかった推定費用（円）。未報告なら既定の概算（検索1回の概算）を使う */
  costJpy?: number;
  cached?: boolean;
}
/** Web検索。実装は交換可能（Anthropic の web_search ツール／外部の検索API／モック）。配列だけ返してもよい */
export interface SearchProvider {
  readonly name: string;
  search(query: string): Promise<SearchHit[] | SearchOutcome>;
}
export type FetchedPage = { ok: true; url: string; finalUrl: string; title: string; text: string; links?: { text: string; href: string }[]; /** HTML全体から抽出した、同じイベントを示す識別子（本文・リンクの切り詰め前。抽選グループの判定用。Stage 8F-4） */ identifiers?: { kind: string; value: string }[]; cached?: boolean; /** 本文を実際に取得した日時（ISO）。キャッシュから返したときは、最初に取得した日時 */ fetchedAt?: string } | { ok: false; message: string };
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
  /** 検索1回の既定の概算費用（円）。プロバイダーが実費を報告しないとき（モック等）に使う */
  searchCostJpy?: number;
}

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const flat = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "");

// ---------------------------------------------------------------- キャッシュ（同じ検索・同じページを繰り返し取得しない）
export interface ResultCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
}
export class MemoryCache implements ResultCache {
  private readonly m = new Map<string, { at: number; v: unknown }>();
  constructor(private readonly ttlMs = 24 * 3600_000, private readonly now: () => number = Date.now) {}
  get(key: string): unknown | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) return void this.m.delete(key);
    return e.v;
  }
  set(key: string, value: unknown): void {
    this.m.set(key, { at: this.now(), v: value });
  }
  get size(): number {
    return this.m.size;
  }
}
export class CachedSearch implements SearchProvider {
  readonly name: string;
  constructor(private readonly inner: SearchProvider, private readonly cache: ResultCache) {
    this.name = `${inner.name}+cache`;
  }
  async search(query: string): Promise<SearchOutcome> {
    const key = `search:${flat(query).toLowerCase()}`;
    const hit = this.cache.get(key) as SearchHit[] | undefined;
    if (hit) return { hits: hit, costJpy: 0, cached: true };
    const r = await this.inner.search(query);
    const out: SearchOutcome = Array.isArray(r) ? { hits: r } : r;
    if (out.hits.length > 0) this.cache.set(key, out.hits); // 空の結果・失敗はキャッシュしない
    return out;
  }
}
export class CachedFetcher implements PageFetcher {
  constructor(private readonly inner: PageFetcher, private readonly cache: ResultCache) {}
  async fetchPage(url: string): Promise<FetchedPage> {
    const key = `page:${url}`;
    const hit = this.cache.get(key) as FetchedPage | undefined;
    if (hit) return { ...(hit as Extract<FetchedPage, { ok: true }>), cached: true };
    const r = await this.inner.fetchPage(url);
    if (!r.ok) return r;
    // 取得した日時を、本文と一緒に保存する（どの時点の内容かを後から確認できるように。Stage 8D-6）
    const stamped: FetchedPage = { ...r, fetchedAt: r.fetchedAt ?? new Date().toISOString() };
    this.cache.set(key, stamped);
    return stamped;
  }
}

// ---------------------------------------------------------------- 本文の要約（AIへ渡す量を減らし、住所のある行を優先する）
const ADDRESS_LINE = /(?:東京都|北海道|(?:京都|大阪)府|[^\s。、]{2,3}県).{0,40}?[市区町村郡].{0,40}?\d/;
/** 本文から、冒頭と、店舗名・住所らしい行（前後1行）を抜き出す。長いページでも住所の記載を見落とさず、トークンも抑える */
export function excerptForAddress(text: string, storeToken: string, maxChars = 3500): string {
  const lines = text.split("\n");
  if (text.length <= maxChars) return text;
  const tok = flat(storeToken);
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(lines.length, 6); i++) keep.add(i);
  lines.forEach((l, i) => {
    if (ADDRESS_LINE.test(l.normalize("NFKC")) || (tok && flat(l).includes(tok)) || /(会社概要|運営会社|企業情報|店舗一覧|閉店|移転)/.test(l)) {
      for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j);
    }
  });
  let out = "";
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (out.length + lines[i].length > maxChars) break;
    out += lines[i] + "\n";
  }
  return out.trim();
}

/** 取得してよいURL: 検索結果に出たもの、登録済みの公式サイト、取得したページが同じドメイン内へ張ったリンク。AI（や外部文面）が作った任意のURLは取得しない */
export function buildStoreLocationTools(deps: StoreToolDeps): ToolRegistry {
  const allowed = new Set<string>(deps.store.knownDomains.map((d) => `https://${d}`));
  const registry = new ToolRegistry();
  const tokenOf = () => deps.store.name.replace(deps.store.chain, "").replace(/[\s　]+|店$/g, "") || deps.store.name;

  const webSearch: AgentTool = {
    name: "web_search",
    description: "Webを検索して、ページのタイトル・URL・要約を返す。検索語は店舗名・系列名・住所・公式サイト・店舗一覧・会社概要などを工夫して変えてよい（回数に上限があり、費用がかかる。同じ検索の繰り返しは避ける）",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "検索語" } }, required: ["query"] },
    access: "read_external",
    consumes: "search",
    // 空白・全角半角・大文字小文字の違いだけの同じ検索語は、同じ検索として断る（無駄な再検索の防止）
    dedupeKey: (input) => flat(str(input.query, 120)).toLowerCase() || null,
    async run(input, ctx) {
      const query = str(input.query, 120);
      if (!query) throw new Error("検索語が空です");
      const r = await deps.search.search(query);
      const out: SearchOutcome = Array.isArray(r) ? { hits: r } : r;
      // 実費（検索料金＋トークン）を推定費用へ。キャッシュから返したときは加算しない
      if (!out.cached) ctx.budget.addCost(out.costJpy ?? deps.searchCostJpy ?? 1.5);
      const hits = out.hits.slice(0, 8);
      for (const h of hits) allowed.add(h.url);
      const content = hits.length ? hits.map((h, i) => `${i + 1}. ${h.title} | ${h.url} | ${h.snippet}`).join("\n") : "（該当なし）";
      return { content: out.cached ? `（保存済みの結果を再利用）\n${content}` : content, untrusted: true, data: { query, hits } } satisfies ToolOutput;
    },
  };

  const fetchPage: AgentTool = {
    name: "fetch_page",
    description: "検索結果に出たページ（または登録済みの公式サイト、取得済みページと同じサイト内のリンク）の本文を取得する。住所・店舗名・会社概要を含む部分を優先して返す。ログインが必要なページや、ロボット制限のあるページは取得できない",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    access: "read_external",
    consumes: "fetch",
    // 同じページ（#以降・末尾の/の違いだけ）の再取得は断る
    dedupeKey: (input) => str(input.url, 500).replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase() || null,
    async run(input) {
      const url = str(input.url, 500);
      if (![...allowed].some((a) => a === url || (url.startsWith(a) && a.split("/").length <= 3))) {
        throw new Error("検索結果に出ていないURLは取得しません");
      }
      const r = await deps.fetcher.fetchPage(url);
      if (!r.ok) throw new Error(r.message);
      const text = r.text.slice(0, 20_000);
      // 同じサイト内のリンクは、次に取得してよいURLに加える（公式サイト内の店舗一覧・会社概要などをたどるため）
      const dom = domainOf(r.finalUrl);
      const links = (r.links ?? []).filter((l) => domainOf(l.href) === dom).slice(0, 30);
      for (const l of links) allowed.add(l.href);
      const linkLines = links.length ? `\n[同じサイト内のリンク]\n${links.slice(0, 15).map((l) => `${l.text} → ${l.href}`).join("\n")}` : "";
      return { content: `${r.title}${r.cached ? "（保存済みの本文を再利用）" : ""}\n${excerptForAddress(text, tokenOf())}${linkLines}`, untrusted: true, data: { url, finalUrl: r.finalUrl, title: r.title, text, domain: dom, links: r.links ?? [], cached: !!r.cached, fetchedAt: r.fetchedAt ?? new Date().toISOString() } };
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
    description: "調査対象の店舗の登録情報（系列名・店舗名・都道府県・同じ系列の他店舗名・登録済みの住所・信頼済みの公式サイトのドメイン）を読む（読み取り専用）",
    inputSchema: { type: "object", properties: {} },
    access: "read_internal",
    async run() {
      const s = deps.store;
      return {
        content: JSON.stringify({ 系列: s.chain, 店舗: s.name, 都道府県: s.prefecture || "不明", 同じ系列の他店舗: s.siblingNames.slice(0, 20), 登録済みの住所: deps.existingAddress ?? "なし", 信頼済みの公式ドメイン: s.knownDomains }),
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
