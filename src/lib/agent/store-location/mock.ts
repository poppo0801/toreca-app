/**
 * モック（Stage 8D-2）: 実APIを使わずに、エージェントの一連の動作を検証するための部品。
 *  - MockWorld: 架空のWeb（ページと検索結果）。検索・取得は、ここにあるものだけを返す。
 *  - MockStoreBrain: 決まった方針で、検索→取得→（不足なら）検索語を変えて追加検索→提案、と進める疑似AI。
 *    実際のAIの判断力の評価ではなく、「基盤（ツール選択・上限・検証）が正しく働くか」の検証用。
 */
import type { AgentLLM, AgentMessage, LlmStep, ToolCall } from "@/lib/agent/core";
import type { PageFetcher, SearchHit, SearchProvider, FetchedPage } from "@/lib/agent/store-location/tools";
import type { GeoHit } from "@/lib/geocode";

export interface WorldPage {
  url: string;
  title: string;
  text: string;
  links?: { text: string; href: string }[];
}
export interface MockWorldData {
  pages: WorldPage[];
  /** 地図（国土地理院の住所検索の偽物）: 住所（先頭一致）→ 座標 */
  geocode: { title: string; lat: number; lng: number }[];
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
const tokens = (q: string) => q.normalize("NFKC").toLowerCase().split(/[\s　]+/).filter((t) => t.length >= 2);

export class MockSearch implements SearchProvider {
  readonly name = "mock-search";
  queries: string[] = [];
  constructor(private readonly world: MockWorldData) {}
  async search(query: string): Promise<SearchHit[]> {
    this.queries.push(query);
    const ts = tokens(query).filter((t) => !/^(住所|所在地|公式|アクセス|店舗一覧)$/.test(t));
    const scored = this.world.pages
      .map((p) => {
        const hay = norm(`${p.title} ${p.text}`);
        const score = ts.filter((t) => hay.includes(norm(t))).length / Math.max(ts.length, 1);
        return { p, score };
      })
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return scored.map(({ p }) => ({ title: p.title, url: p.url, snippet: p.text.replace(/\s+/g, " ").slice(0, 80) }));
  }
}

export class MockFetcher implements PageFetcher {
  fetched: string[] = [];
  constructor(private readonly world: MockWorldData) {}
  async fetchPage(url: string): Promise<FetchedPage> {
    this.fetched.push(url);
    const p = this.world.pages.find((x) => x.url === url);
    return p ? { ok: true, url, finalUrl: url, title: p.title, text: p.text, links: p.links } : { ok: false, message: "ページが見つかりません" };
  }
}

export const mockGeocode = (world: MockWorldData) => async (query: string): Promise<GeoHit[] | null> =>
  world.geocode.filter((g) => norm(query).startsWith(norm(g.title)) || norm(g.title).startsWith(norm(query))).map((g) => ({ title: g.title, lat: g.lat, lng: g.lng }));

// ---------------------------------------------------------------- 疑似AI
const ADDRESS_RE = /((?:東京都|北海道|(?:京都|大阪)府|[^\s。、「」（）()]{2,3}県)[^\s。、「」（）()]{2,30}?[市区町村郡][^\s。、「」（）()]{0,30}?\d+[-‐－ー丁目番地]+\d*[-‐－ー号]*\d*)/;

function lastSearchUrls(messages: AgentMessage[]): { url: string; line: string }[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && m.name === "web_search" && !m.isError) {
      return m.content.split("\n").map((line) => ({ url: /(https?:\/\/[^\s|]+)/.exec(line)?.[1] ?? "", line })).filter((x) => x.url);
    }
  }
  return [];
}

const usageOf = (messages: AgentMessage[], out: string) => ({ inputTokens: Math.ceil(JSON.stringify(messages).length / 3), outputTokens: Math.ceil(out.length / 3), costJpy: 0 });

export class MockStoreBrain implements AgentLLM {
  readonly name = "mock-brain";
  private n = 0;
  constructor(private readonly target: { chain: string; name: string }) {}

  async step({ messages }: { system: string; messages: AgentMessage[] }): Promise<LlmStep> {
    const id = () => `m${++this.n}`;
    const calls = (...c: Omit<ToolCall, "id">[]): LlmStep => ({ kind: "tool_calls", calls: c.map((x) => ({ ...x, id: id() })), usage: usageOf(messages, JSON.stringify(c)) });
    const tools = messages.filter((m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool");
    const searches = tools.filter((t) => t.name === "web_search");
    const fetches = tools.filter((t) => t.name === "fetch_page");
    const fetchedUrls = new Set(messages.flatMap((m) => (m.role === "assistant" ? m.calls.filter((c) => c.name === "fetch_page").map((c) => String(c.input.url)) : [])));
    const askedFetchLimit = tools.some((t) => t.isError && /上限/.test(t.content));

    if (!tools.some((t) => t.name === "read_store")) return calls({ name: "read_store", input: {} }, { name: "past_research", input: {} });
    if (searches.length === 0) return calls({ name: "web_search", input: { query: `${this.target.chain} ${this.target.name} 住所` } });

    // 取得: 最新の検索結果から、まだ取得していないページを最大2件（店舗名が要約に出るものを優先）
    const urls = lastSearchUrls(messages).filter((u) => !fetchedUrls.has(u.url));
    const tok = this.tok();
    const pick = [...urls].sort((a, b) => Number(this.has(b.line, tok)) - Number(this.has(a.line, tok))).slice(0, 2);
    const unfetchedFromLatest = pick.length > 0 && fetches.length < 2 * searches.length && !askedFetchLimit;
    if (unfetchedFromLatest) return calls(...pick.map((p) => ({ name: "fetch_page", input: { url: p.url } })));

    // 提案: 取得したページから、店舗名の近くにある住所を集める
    const found = this.collect(messages);
    // 公式サイトの検証: 住所を見つけたサイトに会社概要へのリンクがあれば、運営会社の情報を取得して裏付ける（公式かどうかの根拠集め）
    const company = found.length > 0 && !askedFetchLimit ? this.companyLink(messages, fetchedUrls, found.map((x) => x.sourceUrl)) : null;
    if (company) return calls({ name: "fetch_page", input: { url: company } });
    // 何も見つからず、検索語をまだ変えていなければ、別の検索語で追加検索する（情報不足時の追加調査）
    if (found.length === 0 && searches.length < 2) return calls({ name: "web_search", input: { query: `${this.target.chain} 店舗一覧 ${this.target.name.replace(this.target.chain, "").trim()} 所在地` } });
    // 住所の候補が1つだけで、まだ別の情報源を調べていなければ、公式情報を探して裏付けを取る
    if (found.length === 1 && searches.length < 2 && !askedFetchLimit) return calls({ name: "web_search", input: { query: `${this.target.chain} 公式 ${this.target.name.replace(this.target.chain, "").trim()} 店舗情報` } });
    return { kind: "final", output: { candidates: found, summary: `${found.length}件の候補` }, usage: usageOf(messages, JSON.stringify(found)) };
  }

  private companyLink(messages: AgentMessage[], fetched: Set<string>, sources: string[]): string | null {
    const hosts = new Set(sources.map((u) => { try { return new URL(u).hostname; } catch { return ""; } }));
    for (const m of messages) {
      if (m.role !== "tool" || m.name !== "fetch_page" || m.isError) continue;
      for (const mm of m.content.matchAll(/(?:会社概要|企業情報|運営会社|会社情報)\s*→\s*(https?:\/\/\S+)/g)) {
        let host = "";
        try { host = new URL(mm[1]).hostname; } catch { /* 無効 */ }
        if (hosts.has(host) && !fetched.has(mm[1])) return mm[1];
      }
    }
    return null;
  }

  private has(line: string, tok: string): boolean {
    const flat = (x: string) => x.normalize("NFKC").replace(/[\s　]+/g, "");
    return flat(line).includes(flat(tok));
  }

  /** 店舗を見分ける語（店舗名から空白・末尾の「店」を除く。系列名で始まる場合は系列名も除く。短すぎれば店舗名そのもの） */
  private tok(): string {
    const flat = (x: string) => x.normalize("NFKC").replace(/[\s　]+/g, "");
    let n = flat(this.target.name);
    const c = flat(this.target.chain);
    if (n.startsWith(c)) n = n.slice(c.length);
    n = n.replace(/店$/, "");
    return n.length >= 2 ? n : flat(this.target.name);
  }

  /** 取得したページの本文（<untrusted_web_content> の中）から、店舗名の近くの住所を引用つきで取り出す */
  private collect(messages: AgentMessage[]): { address: string; sourceUrl: string; quote: string }[] {
    const tok = this.tok();
    const out: { address: string; sourceUrl: string; quote: string }[] = [];
    const callUrl = new Map<string, string>();
    for (const m of messages) if (m.role === "assistant") for (const c of m.calls) if (c.name === "fetch_page") callUrl.set(c.id, String(c.input.url));
    for (const m of messages) {
      if (m.role !== "tool" || m.name !== "fetch_page" || m.isError) continue;
      const url = callUrl.get(m.callId) ?? "";
      for (const line of m.content.split("\n")) {
        const a = ADDRESS_RE.exec(line);
        if (a && this.has(line, tok) && !out.some((o) => o.address === a[1] && o.sourceUrl === url)) {
          out.push({ address: a[1], sourceUrl: url, quote: line.trim().slice(0, 200) });
        }
      }
    }
    return out.slice(0, 5);
  }
}
