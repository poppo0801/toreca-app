import "server-only";
import { extractPageText } from "@/lib/ai/page-text";
import type { FetchedPage, PageFetcher } from "@/lib/agent/store-location/tools";
import { buildQuery } from "@/lib/geocode";
import { fetchCandidates } from "@/lib/server/geocode-service";
import { fetchRespectingRobots } from "@/lib/server/safe-fetch";

/**
 * 実際のWeb・地図に触れる部品（Stage 8D-2）。ページ取得は既存の安全な取得（SSRF対策・内部ネットワーク/ループバックの拒否・
 * リダイレクト先の再検査・サイズ/時間の上限・robots.txt の尊重・ログイン制限の非回避）を使う。
 * 外部の文面は命令として扱わない（本文はデータとして渡す）。APIキー・内部情報は送信しない（URL を取得するだけ）。
 */
export class SafePageFetcher implements PageFetcher {
  private lastAt = 0;
  async fetchPage(url: string): Promise<FetchedPage> {
    // 過剰なアクセスをしない: 取得の間隔を最低1.5秒あける
    const wait = this.lastAt + 1500 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastAt = Date.now();
    const r = await fetchRespectingRobots(url, { timeoutMs: 10_000, maxBytes: 1_000_000 });
    if (!r.ok) return { ok: false, message: r.message };
    const page = extractPageText(r.body, r.finalUrl, 20_000);
    return { ok: true, url, finalUrl: r.finalUrl, title: page.title ?? "", text: page.text, links: page.links };
  }
}

/** 住所 → 国土地理院の住所検索（無料）。失敗は null */
export const realGeocode = async (query: string) => {
  const r = await fetchCandidates(buildQuery(query, null));
  return r.ok ? r.hits : null;
};
