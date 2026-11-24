// @vitest-environment node
/**
 * 実投稿の取得で実測した**分布（件数・字数だけ。原文・ID・URLは含まない）**に合わせた、架空の模擬Webでの再生。
 * 目的: 実際の取得（150リクエスト・単一サイトへの集中・一部の宛先が取得対象外）と同じ形で、①総リクエストが上限を超えない ②少ないリンクの投稿から先に完成する
 *       ③単一ホストの間隔（1.5秒）が守られる ④取得対象外の宛先・予算切れが理由つきで残る、を確認する。実データの内容は使わない（Gitに公開しない）。
 */
import { describe, expect, it, vi } from "vitest";
import type { SafeFetchOptions, SafeFetchResult } from "@/lib/server/safe-fetch";
import { captureRealPosts } from "./real-post-capture";

vi.mock("server-only", () => ({}));

/** 実測（2026-11-24・15投稿）の1投稿あたりの短縮リンク数、ページ本文の字数の代表値、取得対象外の宛先（SNS等）の数 */
const SHAPE = { shortsPerPost: [2, 2, 3, 4, 4, 4, 4, 5, 5, 5, 7, 10, 10, 10, 10], pageChars: [2800, 4900, 4000, 4150, 5200, 10400, 11200, 3900, 6500, 7100], nonFetchable: 12 };

function shapedWeb() {
  const log: { url: string; at: number }[] = [];
  let clock = 0;
  const fetchImpl = async (url: string, o: SafeFetchOptions): Promise<SafeFetchResult> => {
    if (o.beforeRequest?.(new URL(url)) === false) return { ok: false, code: "blocked", message: "limit" };
    log.push({ url, at: clock });
    const u = new URL(url);
    if (u.pathname === "/robots.txt") {
      o.onResponse?.({ host: u.hostname, status: 200, bytes: 30 });
      return { ok: true, finalUrl: url, status: 200, contentType: "text/plain", body: "User-agent: *\nDisallow: /private/\n", truncated: false };
    }
    if (u.hostname === "t.co") {
      const id = u.pathname.slice(1);
      o.onResponse?.({ host: "t.co", status: 301, bytes: 0 });
      // 取得対象外（SNS）の宛先を一部に混ぜる（実測では12件）
      const dest = Number(id.split("k")[1]) % 7 === 0 ? `https://x.com/official/status/${id.replace(/\D/g, "")}` : `https://events.example.invalid/e/${id}`;
      return { ok: true, finalUrl: dest, status: 301, contentType: "", body: "", truncated: false };
    }
    const chars = SHAPE.pageChars[log.length % SHAPE.pageChars.length];
    const text = `【店舗${u.pathname.length}】拡張パックの抽選受付ページです。${"応募期間と応募方法の案内です。".repeat(Math.ceil(chars / 15))}${u.pathname}`;
    o.onResponse?.({ host: u.hostname, status: 200, bytes: text.length });
    return { ok: true, finalUrl: url, status: 200, contentType: "text/html", body: `<html><title>t</title><body><p>${text}</p></body></html>`, truncated: false };
  };
  return { fetchImpl, log, time: { now: () => clock, sleep: async (ms: number) => void (clock += ms) } };
}
const rows = () => SHAPE.shortsPerPost.map((n, i) => ({ id: `shape-${i}`, postUrl: `https://x.com/official/status/${1000000000 + i}`, text: `投稿${i} ${Array.from({ length: n }, (_, k) => `https://t.co/p${i}k${k + 1}`).join(" ")}`, capturedAt: "2026-11-20T00:00:00Z" }));

describe("実測の分布に合わせた再生（架空の内容）", () => {
  it("単一サイトへの集中・取得対象外の宛先・予算切れがあっても、総リクエストは150を超えない。少ないリンクの投稿から先に処理され、止めた理由と未処理が残る", async () => {
    const w = shapedWeb();
    const { report, cases } = await captureRealPosts({ rows: rows(), fetchImpl: w.fetchImpl, maxRequests: 150, ...w.time });
    expect(report.requests.total).toBe(w.log.length);
    expect(report.requests.total).toBeLessThanOrEqual(150);
    expect(report.stoppedBy).toBe("request_budget");
    expect(report.perPost.map((p) => p.shortLinks)).toEqual([...report.perPost.map((p) => p.shortLinks)].sort((a, b) => a - b)); // 少ない順
    expect(report.processed).toBeLessThanOrEqual(15);
    expect(report.perPost.at(-1)!.failed.request_budget).toBeGreaterThan(0); // 最後の投稿は、予算切れで途中までしか取得できない（実測と同じ形）
    expect(report.failures.not_fetchable_class).toBeGreaterThan(0); // SNS等は取得しない
    expect(report.failures.request_budget).toBeGreaterThan(0); // 予算切れの理由が残る
    expect(report.shortLinks.resolved + report.shortLinks.failed).toBe(report.shortLinks.total);
    expect(cases.length).toBeGreaterThan(5);
  });
  it("t.co 以外が単一ホストでも、同じホストへの連続リクエストは1.5秒以上あく（t.co も同様）", async () => {
    const w = shapedWeb();
    await captureRealPosts({ rows: rows().slice(0, 4), fetchImpl: w.fetchImpl, ...w.time });
    const byHost = new Map<string, number[]>();
    for (const l of w.log) byHost.set(new URL(l.url).hostname, [...(byHost.get(new URL(l.url).hostname) ?? []), l.at]);
    for (const [h, ts] of byHost) for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1], h).toBeGreaterThanOrEqual(1500);
    expect(byHost.get("t.co")!.length).toBeGreaterThan(8);
  });
});
