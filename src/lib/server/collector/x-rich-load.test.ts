// @vitest-environment node
/**
 * Phase 2: 複数URL取得の負荷・安全性の再生試験（保存済みのリンク構造とモックの応答だけ。実際のURLには接続しない・仮想時計で待たない）。
 * 検証: ①ホスト別の間隔・同時接続 ②複数投稿にまたがる共有 ③遅いホスト・429・403 ④実行の総量・締切・中止 ⑤取得しなかったリンクと理由が台帳に残る（取りこぼしを隠さない）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostThrottle, RunFetchBudget } from "@/lib/collector/fetch-control";
import { pendingRecheck } from "@/lib/collector/link-plan";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import { enrichXPost, outcomeOf } from "./x-rich";

vi.mock("server-only", () => ({}));
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const BODY = "拡張パックの抽選受付ページです。応募期間と応募方法を記載しています。お一人様1回まで。".repeat(3);
const page = (url: string): SafeFetchResult => ({ ok: true, finalUrl: url, status: 200, contentType: "text/html", body: `<html><title>t</title><body><p>${BODY}</p></body></html>`, truncated: false });
const post = (id: number, hosts: number, perHost: number) => ({ text: `投稿${id} 抽選のお知らせ`, links: Array.from({ length: hosts * perHost }, (_, i) => `https://h${i % hosts}.example.invalid/p${id}/${i}`), images: [] as string[] });
const noImg = async () => null;

interface Sim {
  starts: Record<string, number[]>;
  active: Record<string, number>;
  peakByHost: Record<string, number>;
  peakGlobal: number;
}
const sim = (latency: (host: string) => number, behavior: (host: string, n: number) => SafeFetchResult | null = () => null) => {
  const s: Sim = { starts: {}, active: {}, peakByHost: {}, peakGlobal: 0 };
  let live = 0;
  const count: Record<string, number> = {};
  const fetchPage = async (url: string): Promise<SafeFetchResult> => {
    const host = new URL(url).hostname;
    (s.starts[host] ??= []).push(Date.now());
    s.active[host] = (s.active[host] ?? 0) + 1;
    s.peakByHost[host] = Math.max(s.peakByHost[host] ?? 0, s.active[host]);
    live++;
    s.peakGlobal = Math.max(s.peakGlobal, live);
    await new Promise((r) => setTimeout(r, latency(host)));
    live--;
    s.active[host]--;
    count[host] = (count[host] ?? 0) + 1;
    return behavior(host, count[host]) ?? page(url);
  };
  return { s, fetchPage };
};

describe("取得結果の分類（ホストの制御用）", () => {
  it("404は『ページが無い』だけでホストの不調として数えない。429/503はバックオフ、401/403/robots/blockedは拒否、その他の失敗は失敗", () => {
    const e = (code: string, status?: number) => ({ ok: false, code, status, message: "" }) as SafeFetchResult;
    expect(outcomeOf(page("https://x.example.invalid/"))).toBe("ok");
    expect(outcomeOf(e("http_error", 404))).toBe("ok");
    expect(outcomeOf(e("http_error", 429))).toBe("rate_limited");
    expect(outcomeOf(e("http_error", 503))).toBe("rate_limited");
    expect(outcomeOf(e("http_error", 403))).toBe("blocked");
    expect(outcomeOf(e("robots"))).toBe("blocked");
    expect(outcomeOf(e("timeout"))).toBe("failure");
  });
});

describe("複数投稿が同時に収集される負荷（共有の制御）", () => {
  it("10投稿×24リンク（8ホスト）が同時に走っても、ホスト別の同時接続は1・全体の同時接続は上限内・開始間隔は守られ、取得しなかったリンクは理由つきで全て台帳に残る", async () => {
    const throttle = new HostThrottle({ minIntervalMs: 1500, maxGlobal: 4 });
    const budget = new RunFetchBudget({ maxRequests: 120, maxBytes: 1e9, maxImages: 10 });
    const { s, fetchPage } = sim(() => 600);
    const runs = Array.from({ length: 10 }, (_, i) => enrichXPost(post(i, 8, 3), { fetchPage, fetchImage: noImg, control: { throttle, budget } }));
    await vi.advanceTimersByTimeAsync(600_000);
    const results = await Promise.all(runs);
    expect(Math.max(...Object.values(s.peakByHost))).toBe(1);
    expect(s.peakGlobal).toBeLessThanOrEqual(4);
    for (const starts of Object.values(s.starts)) for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1500);
    // 総量の上限（120）: それ以上は取得せず、理由つきで残す。24リンク×10投稿＝240リンク全てが台帳にある
    expect(budget.requests).toBeLessThanOrEqual(120);
    const ledgers = results.map((r) => r.linkLedger);
    expect(ledgers.reduce((n, l) => n + l.length, 0)).toBe(240);
    const notFetched = ledgers.flat().filter((e) => e.status !== "fetched");
    expect(notFetched.length).toBeGreaterThan(0);
    for (const e of notFetched) expect(e.reason, e.url).toBeTruthy(); // 無言で捨てない
    expect(notFetched.some((e) => e.reason === "budget_requests" || e.reason === "deadline")).toBe(true);
    // 再調査の対象として取り出せる（本当に取得できないものとは区別される）
    expect(ledgers.flat().filter((e) => e.reason === "budget_requests").length).toBe(pendingRecheck(ledgers.flat()).filter((e) => e.reason === "budget_requests").length);
    // 取得できたものの全文は後段へ渡る
    expect(results.reduce((n, r) => n + r.linkedPages.length, 0)).toBe(budget.requests);
  });

  it("429が続く遅いホストは、バックオフの後に止める。他のホストは取得を続け、止めたホストのリンクは『host_suspended』で台帳に残る", async () => {
    const throttle = new HostThrottle({ minIntervalMs: 500, baseBackoffMs: 1000, rateLimitLimit: 2 });
    const { s, fetchPage } = sim(() => 100, (host) => (host === "h0.example.invalid" ? ({ ok: false, code: "http_error", status: 429, message: "slow down" } as SafeFetchResult) : null));
    const r = enrichXPost(post(1, 3, 4), { fetchPage, fetchImage: noImg, control: { throttle } });
    await vi.advanceTimersByTimeAsync(300_000);
    const out = await r;
    const h0 = out.linkLedger.filter((e) => e.host === "h0.example.invalid");
    expect(s.starts["h0.example.invalid"]).toHaveLength(2); // 2回の429で停止
    expect(h0.filter((e) => e.reason === "host_suspended").length).toBe(2);
    expect(out.linkedPages.filter((p) => p.url.includes("h1.") || p.url.includes("h2.")).length).toBe(8); // 他のホストは全て取得
    expect(throttle.suspendedHosts().map((x) => x.host)).toEqual(["h0.example.invalid"]);
  });

  it("403を返すホストは2回で止める（回避しない）。ログインが必要なページは未確認として残る", async () => {
    const throttle = new HostThrottle({ minIntervalMs: 0, failLimit: 2 });
    const { fetchPage } = sim(() => 10, (host) => (host === "h0.example.invalid" ? ({ ok: false, code: "http_error", status: 403, message: "" } as SafeFetchResult) : null));
    const r = enrichXPost(post(2, 2, 4), { fetchPage, fetchImage: noImg, control: { throttle } });
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await r;
    const h0 = out.linkLedger.filter((e) => e.host === "h0.example.invalid");
    expect(h0.map((e) => e.reason)).toEqual(["http_error", "http_error", "host_suspended", "host_suspended"]);
    expect(h0.every((e) => e.status !== "fetched")).toBe(true);
  });

  it("1投稿90秒の締切: 遅いホストのリンクは、締切を超えると取得せず『deadline』などで台帳に残る（取りこぼしを可視化）", async () => {
    const throttle = new HostThrottle({ minIntervalMs: 0, maxGlobal: 1 });
    const { fetchPage } = sim(() => 20_000); // 1ページ20秒
    const r = enrichXPost(post(3, 6, 1), { fetchPage, fetchImage: noImg, control: { throttle } });
    await vi.advanceTimersByTimeAsync(400_000);
    const out = await r;
    expect(out.linkedPages.length).toBeGreaterThan(0);
    expect(out.linkedPages.length).toBeLessThan(6);
    const missed = out.linkLedger.filter((e) => e.status !== "fetched");
    expect(missed.length).toBe(6 - out.linkedPages.length);
    expect(missed.every((e) => e.reason === "deadline" || e.reason === "time_limit")).toBe(true);
    expect(pendingRecheck(out.linkLedger)).toHaveLength(missed.length);
  });

  it("中止（収集の時間切れが近い）: 新しい取得を始めず、残りは『cancelled』として台帳に残る", async () => {
    let cancel = false;
    const throttle = new HostThrottle({ minIntervalMs: 0 });
    const { fetchPage } = sim(() => 100);
    const r = enrichXPost(post(4, 4, 2), { fetchPage: async (u) => { const x = await fetchPage(u); cancel = true; return x; }, fetchImage: noImg, control: { throttle, shouldCancel: () => cancel } });
    await vi.advanceTimersByTimeAsync(60_000);
    const out = await r;
    expect(out.linkedPages).toHaveLength(1);
    expect(out.linkLedger.filter((e) => e.reason === "cancelled")).toHaveLength(7);
  });

  it("制御なし（単件解析・従来の呼び出し）は従来どおり動く（互換）", async () => {
    const { fetchPage } = sim(() => 1);
    const r = enrichXPost(post(5, 2, 2), { fetchPage, fetchImage: noImg });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await r).linkedPages).toHaveLength(4);
  });
});
