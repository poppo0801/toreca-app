import "server-only";
import { createHash } from "node:crypto";
import { extractPageText } from "@/lib/ai/page-text";
import { HostThrottle, RunFetchBudget } from "@/lib/collector/fetch-control";
import { looksLikeLoginWall, discoverLinks, planLinkFetches } from "@/lib/collector/link-plan";
import type { RealPostCase } from "@/lib/judgment/xsource/compare-eval";
import { fetchRespectingRobots, safeFetch, type SafeFetchResult } from "@/lib/server/safe-fetch";
import { OEMBED_EXPAND_MAX } from "@/lib/server/x-source";

/**
 * 実投稿の複数リンク案件の資料化（Phase 2）。保存済みの実投稿（本文に短縮URLが残るが、展開先・リンク先の本文が保存されていない）から、
 * 短縮URLの展開（公開のリダイレクト先を読むだけ）とリンク先の公開ページの取得を行い、出所つきの案件（RealPostCase）にする。
 *  - **既定では実行しない**: 実際のネットワーク接続を伴う（無課金だが第三者サイトへの実アクセス）ため、呼び出し側が明示的に許可したときだけ（compare-real の real-posts-expand）。テストは差し替えた取得だけ。
 *  - 守ること: robots.txt・SSRF対策（既存の safeFetch）・ホスト別の間隔・総リクエスト数の上限・ログイン必須/危険/SNSは取得しない（回避しない）。有料のX API・検索は使わない。取得できなければ、できなかった理由を報告に残す（実例が揃ったふりをしない）。
 *  - AIの出力は使わない。gold は作らない（人が確認して別に作る）。
 */
export interface CaptureRow {
  id: string;
  postUrl: string;
  text: string;
  capturedAt: string;
}
export interface CaptureReport {
  posts: number;
  withMultiLinks: number;
  built: number;
  requests: number;
  perPost: { id: string; shortLinks: number; expanded: number; unexpanded: number; pagesFetched: number; failed: Record<string, number> }[];
  stoppedBy: string | null;
}

const hash8 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 8);
const T_CO = /https:\/\/t\.co\/[A-Za-z0-9]+/g;

export async function captureRealPosts(a: {
  rows: readonly CaptureRow[];
  maxRequests?: number;
  minIntervalMs?: number;
  /** 取得の差し替え（テスト）。既定は safeFetch / fetchRespectingRobots */
  expandFetch?: typeof safeFetch;
  fetchPage?: (u: string) => Promise<SafeFetchResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ cases: RealPostCase[]; report: CaptureReport }> {
  const budget = new RunFetchBudget({ maxRequests: a.maxRequests ?? 150, maxBytes: 100 * 1024 * 1024, maxImages: 0 });
  const throttle = new HostThrottle({ minIntervalMs: a.minIntervalMs ?? 1500, maxGlobal: 2, ...(a.now ? { now: a.now } : {}), ...(a.sleep ? { sleep: a.sleep } : {}) });
  const expandFetch = (async (u: string, o: Parameters<typeof safeFetch>[1]) => {
    const b = budget.tryStart("page");
    if (!b.ok) return { ok: false, code: "network", message: "budget" } as SafeFetchResult;
    const t = await throttle.run("t.co", async () => ({ value: await (a.expandFetch ?? safeFetch)(u, o), outcome: "ok" as const }));
    return t.ran ? t.value : ({ ok: false, code: "network", message: t.cause } as SafeFetchResult);
  }) as typeof safeFetch;
  const fetchPage = a.fetchPage ?? ((u: string) => fetchRespectingRobots(u));
  const cases: RealPostCase[] = [];
  const report: CaptureReport = { posts: a.rows.length, withMultiLinks: 0, built: 0, requests: 0, perPost: [], stoppedBy: null };
  for (const row of a.rows) {
    const shorts = [...new Set(row.text.match(T_CO) ?? [])];
    if (shorts.length < 2) continue;
    report.withMultiLinks++;
    // 短縮URLごとに展開し、**短縮URL→宛先の対応を保つ**（順序で対応づけない。取り違えは正解との照合を壊すため）
    const map: { short: string; url: string }[] = [];
    const unexpanded: string[] = [];
    for (const [i, sh] of shorts.entries()) {
      if (i >= OEMBED_EXPAND_MAX) {
        unexpanded.push(sh);
        continue;
      }
      const r = await expandFetch(sh, { noFollow: true, timeoutMs: 4_000, accept: ["text/html", "text/plain"] });
      if (r.ok && r.finalUrl && r.finalUrl !== sh && r.finalUrl.startsWith("https://")) map.push({ short: sh, url: r.finalUrl });
      else unexpanded.push(sh);
    }
    const expanded = map.map((m) => m.url);
    // 取得してよいリンクだけ（SNS・短縮・危険・不正は取得しない）。順序は投稿の順
    const plan = planLinkFetches(discoverLinks({ links: expanded })).filter((p) => p.decision === "fetch");
    const failed: Record<string, number> = {};
    const pages: { url: string; text: string }[] = [];
    const fetchedUrls = new Set<string>();
    for (const p of plan) {
      const b = budget.tryStart("page");
      if (!b.ok) {
        report.stoppedBy = b.cause;
        failed[b.cause] = (failed[b.cause] ?? 0) + 1;
        continue;
      }
      const t = await throttle.run(p.host, async () => ({ value: await fetchPage(p.url).catch((): SafeFetchResult => ({ ok: false, code: "network", message: "x" })), outcome: "ok" as const }));
      if (!t.ran) {
        failed[t.cause] = (failed[t.cause] ?? 0) + 1;
        continue;
      }
      const r = t.value;
      if (!r.ok) {
        failed[r.code] = (failed[r.code] ?? 0) + 1;
        continue;
      }
      const ex = extractPageText(r.body, r.finalUrl, 120_000);
      if (looksLikeLoginWall(ex.text) || ex.text.length < 30) {
        failed[looksLikeLoginWall(ex.text) ? "login_required" : "too_short"] = (failed[looksLikeLoginWall(ex.text) ? "login_required" : "too_short"] ?? 0) + 1;
        continue;
      }
      pages.push({ url: p.url, text: ex.text });
      fetchedUrls.add(p.url);
    }
    report.perPost.push({ id: hash8(row.id), shortLinks: shorts.length, expanded: expanded.length, unexpanded: unexpanded.length, pagesFetched: pages.length, failed });
    if (pages.length >= 2) {
      const linkMap = map.filter((m) => fetchedUrls.has(m.url)); // 本文を取得できた宛先だけ（対応は展開時のもの）
      cases.push({ caseId: `rp${hash8(row.id)}`, postText: row.text, links: [], linkMap, pages, imageRefs: [], imageReadings: [], provenance: { postUrl: row.postUrl, capturedAt: new Date(a.now ? a.now() : Date.now()).toISOString(), source: "saved_public", expandedLinks: expanded.length } });
      report.built++;
    }
  }
  report.requests = budget.requests;
  return { cases, report };
}
