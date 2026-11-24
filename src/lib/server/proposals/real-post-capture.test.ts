// @vitest-environment node
/** 実投稿の複数リンク案件の資料化（差し替えた取得だけ。実際のネットワークには出ない・費用0）。 */
import { describe, expect, it, vi } from "vitest";
import { validateRealPostCases } from "@/lib/judgment/xsource/compare-eval";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import { captureRealPosts } from "./real-post-capture";

vi.mock("server-only", () => ({}));

const dest = (s: string): string => `https://shop-${s.slice(-1)}.example.invalid/e/${s.slice(-1)}`;
const redirect = (url: string): SafeFetchResult => ({ ok: true, finalUrl: url, status: 301, contentType: "", body: "", truncated: false });
const html = (u: string): SafeFetchResult => ({ ok: true, finalUrl: u, status: 200, contentType: "text/html", body: `<html><title>t</title><body><p>【${u.slice(8, 14)}】拡張パックの抽選受付ページです。応募期間と応募方法を記載しています。お一人様1回まで。</p></body></html>`, truncated: false });
const calls: string[] = [];
const expandFetch = (async (u: string) => {
  calls.push(`expand:${u}`);
  return u.endsWith("e") ? ({ ok: false, code: "timeout", message: "x" } as SafeFetchResult) : redirect(dest(u));
}) as never;
const fetchPage = async (u: string): Promise<SafeFetchResult> => {
  calls.push(`page:${u}`);
  return u.includes("shop-c") ? ({ ok: false, code: "robots", message: "x" } as SafeFetchResult) : html(u);
};
const sleep = async () => undefined;
const post = (id: string, shorts: string[]) => ({ id, postUrl: `https://x.com/official/status/${id}`, text: `《A》 《B》 《C》 《D》 ${shorts.join(" ")}`, capturedAt: "2026-11-20T00:00:00Z" });

describe("実投稿の複数リンク案件の資料化", () => {
  it("複数の短縮URLを持つ投稿だけを対象に、短縮URL→宛先の対応を保って展開し、本文を取得して出所つきの案件にする", async () => {
    calls.length = 0;
    const rows = [post("1111111111111", ["https://t.co/a", "https://t.co/b", "https://t.co/d"]), post("2222222222222", ["https://t.co/a"])];
    const { cases, report } = await captureRealPosts({ rows, expandFetch, fetchPage, sleep, minIntervalMs: 0 });
    expect(report).toMatchObject({ posts: 2, withMultiLinks: 1, built: 1 });
    expect(cases).toHaveLength(1);
    const c = cases[0];
    expect(c.linkMap).toEqual([{ short: "https://t.co/a", url: dest("a") }, { short: "https://t.co/b", url: dest("b") }, { short: "https://t.co/d", url: dest("d") }]); // 短縮URLと宛先の対応が正しい
    expect(c.pages.map((p) => p.url)).toEqual(c.linkMap.map((m) => m.url));
    expect(c.provenance).toMatchObject({ postUrl: "https://x.com/official/status/1111111111111", source: "saved_public", expandedLinks: 3 });
    expect(validateRealPostCases(cases).ok).toBe(true);
    expect(calls.filter((x) => x.startsWith("expand:"))).toHaveLength(3); // 1リンクの投稿は対象外（アクセスしない）
  });
  it("展開できない短縮URL・robotsが禁止するページは回避せず、理由を報告に残す。本文が2ページ未満なら案件にしない（実例が揃ったふりをしない）", async () => {
    const rows = [post("3333333333333", ["https://t.co/e", "https://t.co/c"])]; // e=展開失敗・c=robots拒否
    const { cases, report } = await captureRealPosts({ rows, expandFetch, fetchPage, sleep, minIntervalMs: 0 });
    expect(cases).toEqual([]);
    expect(report.perPost[0]).toMatchObject({ shortLinks: 2, expanded: 1, unexpanded: 1, pagesFetched: 0 });
    expect(report.perPost[0].failed).toEqual({ robots: 1 });
  });
  it("総リクエスト数の上限で止まり、止めた理由を報告に残す。上限を超える取得はしない", async () => {
    calls.length = 0;
    const rows = [post("4444444444444", ["https://t.co/a", "https://t.co/b", "https://t.co/d"])];
    const { report } = await captureRealPosts({ rows, expandFetch, fetchPage, sleep, minIntervalMs: 0, maxRequests: 4 });
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(report.stoppedBy).toBe("budget_requests");
  });
});
