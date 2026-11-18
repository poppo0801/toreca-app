/**
 * 実際のWeb調査を模した、架空の世界（Stage 9H-3P。テスト・比較用）。実ネットワーク・実AI・DBに触れない。
 * 検索は語の一致で上位を返す（実検索の代わり）。取得は登録されたページだけ。制限（robots）を再現できる。
 */
import type { DiscoveryWorld, ExistingLottery, KnownStore } from "./types";

export interface SimPage {
  title: string;
  text: string;
  links?: { url: string; text: string }[];
  /** false なら検索結果に出ない（リンクからしか辿れない） */
  searchable?: boolean;
}
export interface SimWorldSpec {
  pages: Record<string, SimPage>;
  /** 取得できない（robots・ログイン）URL */
  blocked?: string[];
  existing?: ExistingLottery[];
  stores?: Record<string, KnownStore[]>;
  officialUrl?: Record<string, string>;
  searchCostJpy?: number;
  noSearch?: boolean;
}
export interface SimWorld extends DiscoveryWorld {
  calls: { fetch: string[]; search: string[] };
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase();

export function createSimWorld(spec: SimWorldSpec): SimWorld {
  const calls = { fetch: [] as string[], search: [] as string[] };
  const w: SimWorld = {
    calls,
    async fetchPage(url) {
      calls.fetch.push(url);
      if ((spec.blocked ?? []).includes(url)) return { ok: false, reason: "robots.txt により取得できません" };
      const p = spec.pages[url];
      return p ? { ok: true, title: p.title, text: p.text, links: p.links ?? [] } : { ok: false, reason: "ページが見つかりません（404）" };
    },
    lastSearchCostJpy: () => spec.searchCostJpy ?? 0,
    async existing(q) {
      const ex = spec.existing ?? [];
      return ex.filter((e) => (!!q.url && e.sourceUrls.includes(q.url)) || ((!q.chain || norm(e.chain) === norm(q.chain)) && (!q.store || norm(e.store).replace(/店$/, "") === norm(q.store).replace(/店$/, "")) && (!q.product || e.products.some((p) => norm(p).includes(norm(q.product ?? "")) || norm(q.product ?? "").includes(norm(p))))));
    },
    async knownStores(chain) {
      return spec.stores?.[chain] ?? [];
    },
    async chainOfficialUrl(chain) {
      return spec.officialUrl?.[chain] ?? null;
    },
  };
  if (!spec.noSearch) {
    w.search = async (query: string) => {
      calls.search.push(query);
      const tokens = norm(query).split(/\s+/).filter(Boolean);
      return Object.entries(spec.pages)
        .filter(([, p]) => p.searchable !== false)
        .map(([url, p]) => ({ url, p, score: tokens.filter((t) => norm(`${p.title} ${p.text}`).includes(t)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((x) => ({ title: x.p.title, url: x.url, snippet: x.p.text.slice(0, 120) }));
    };
  }
  return w;
}
