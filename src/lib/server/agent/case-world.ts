import "server-only";
import type { PlannerWorld } from "@/lib/agent/collection-planner/types";
import type { RealRunGuard } from "@/lib/agent/collection-planner/real-guard";
import { WEB_SEARCH_JPY } from "@/lib/agent/anthropic";
import type { PageFetcher, SearchProvider } from "@/lib/agent/store-location/tools";
import { digest, excerpt, redact } from "@/lib/case-model/redact";
import { SafePageFetcher } from "@/lib/server/agent/real-providers";

/**
 * 案件調査の外部アクセス（Stage 9H-2・開発専用）。読み取りのみ。
 *  ページ取得: 既存の安全な取得（SSRF対策・robots.txt の尊重・同一サイトの間隔・サイズ/時間の上限。ログイン・取得制限は回避しない）
 *  検索     : Anthropic の web_search（既存の開発専用キー・追加契約なし。1,000回あたり10ドル）。検索語に個人情報は入らない（ツール側で拒否済み）
 * 検索の費用（検索料金＋トークン）は費用の台帳（guard）へ記録し、呼び出しの前に最大費用を確認する（累計・1ケースの上限を超える見込みなら呼ばない）。
 * 取得・検索の実行ログ（日時・成否）を保持する（評価の記録用）。DBには何も書かない。
 */
export interface WorldLogEntry {
  at: string;
  kind: "fetch" | "search";
  target: string;
  ok: boolean;
  detail: string;
  costJpy?: number;
  /** 取得したページ（保存用。本文は伏せ字にした先頭の抜粋とハッシュ・長さ。全文は保存しない） */
  page?: { title: string; length: number; digest: string; excerpt: string; linkCount: number };
  /** 検索結果（タイトルとURL） */
  results?: { title: string; url: string }[];
}

/** 検索1回の最大費用の見込み（検索料金＋トークン）。実際より多めに見積もる */
/** 保存するページ本文の抜粋の長さ（伏せ字のうえ先頭から。保存容量の上限） */
export const PAGE_EXCERPT_CHARS = 4000;
export const SEARCH_WORST_JPY = WEB_SEARCH_JPY * 1 + 1.5;

export function createCaseWorld(o: { fetcher?: PageFetcher; search?: SearchProvider; guard?: RealRunGuard; now?: () => Date }): { world: PlannerWorld; log: WorldLogEntry[] } {
  const fetcher = o.fetcher ?? new SafePageFetcher();
  const now = o.now ?? (() => new Date());
  const log: WorldLogEntry[] = [];
  let lastCost = 0;
  const world: PlannerWorld = {
    signals: async () => ({ today: now().toISOString().slice(0, 10), releases: [], chains: [], missing: [], failed: [], monitors: [], discovery: { found7d: 0, registered7d: 0, held7d: 0 } }),
    matchExisting: async () => [],
    fetchPage: async (url) => {
      const r = await fetcher.fetchPage(url);
      if (!r.ok) {
        log.push({ at: now().toISOString(), kind: "fetch", target: url, ok: false, detail: r.message.slice(0, 200) });
        return { ok: false, reason: r.message };
      }
      const links = (r.links ?? []).map((l) => ({ url: l.href, text: l.text }));
      log.push({ at: now().toISOString(), kind: "fetch", target: url, ok: true, detail: `${r.text.length}文字・リンク${links.length}件`, page: { title: redact(r.title ?? "").slice(0, 120), length: r.text.length, digest: digest(r.text), excerpt: excerpt(r.text, PAGE_EXCERPT_CHARS), linkCount: links.length } });
      return { ok: true, title: r.title, text: r.text, links };
    },
    ...(o.search
      ? {
          search: async (query: string) => {
            o.guard?.precheck(SEARCH_WORST_JPY);
            lastCost = 0;
            try {
              const raw = await o.search!.search(query);
              const hits = Array.isArray(raw) ? raw : raw.hits;
              // 費用が報告されないときは、検索1回の料金の概算を使う（0円にしない）
              const cost = Array.isArray(raw) || raw.costJpy === undefined ? WEB_SEARCH_JPY : raw.costJpy;
              lastCost = cost;
              o.guard?.chargeJpy("search", cost);
              log.push({ at: now().toISOString(), kind: "search", target: query, ok: true, detail: `${hits.length}件`, costJpy: cost, results: hits.slice(0, 8).map((h) => ({ title: redact(h.title).slice(0, 120), url: h.url.slice(0, 300) })) });
              return hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet }));
            } catch (e) {
              log.push({ at: now().toISOString(), kind: "search", target: query, ok: false, detail: (e as Error).message?.slice(0, 200) ?? "失敗" });
              throw e;
            }
          },
          lastSearchCostJpy: () => lastCost,
        }
      : {}),
  };
  return { world, log };
}
