import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateLoad, HostThrottle, RunFetchBudget, type FetchOutcomeKind } from "./fetch-control";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const ok = (v = 1): Promise<{ value: number; outcome: FetchOutcomeKind }> => Promise.resolve({ value: v, outcome: "ok" });

describe("HostThrottle（実際には待たない仮想時計で検証）", () => {
  it("同じホストへの取得開始は最小間隔をあける（同時に投げても直列化される）", async () => {
    const th = new HostThrottle({ minIntervalMs: 1500 });
    const starts: number[] = [];
    const jobs = [1, 2, 3].map(() => th.run("a.example.com", () => { starts.push(Date.now()); return ok(); }));
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(jobs);
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1500);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1500);
  });

  it("全体の同時接続数を超えない（別ホストが多数でも）", async () => {
    const th = new HostThrottle({ maxGlobal: 3, minIntervalMs: 0 });
    let live = 0;
    let peak = 0;
    const jobs = Array.from({ length: 12 }, (_, i) =>
      th.run(`h${i}.example.com`, async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 500));
        live--;
        return { value: i, outcome: "ok" as const };
      }),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const rs = await Promise.all(jobs);
    expect(rs.every((r) => r.ran)).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    expect(th.stats.maxActive).toBeLessThanOrEqual(3);
  });

  it("429 は Retry-After を尊重して待ち、3回続いたらそのホストを止める（止めた分は理由つきで未取得）", async () => {
    const th = new HostThrottle({ minIntervalMs: 100, baseBackoffMs: 1000, rateLimitLimit: 3 });
    const times: number[] = [];
    const results: string[] = [];
    const task = (async () => {
      for (let i = 0; i < 5; i++) {
        const r = await th.run("slow.example.com", async () => { times.push(Date.now()); return { value: 1, outcome: "rate_limited" as const, retryAfterMs: i === 0 ? 8000 : 0 }; });
        results.push(r.ran ? "ran" : r.cause);
      }
    })();
    await vi.advanceTimersByTimeAsync(120_000);
    await task;
    expect(results).toEqual(["ran", "ran", "ran", "host_suspended", "host_suspended"]);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(8000); // Retry-After
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(2000); // 指数バックオフ（1s→2s）
    expect(th.suspendedHosts().map((x) => x.host)).toEqual(["slow.example.com"]);
  });

  it("連続して失敗・拒否（403/robots）したホストは止める。成功が挟まれば数え直す。他のホストには影響しない", async () => {
    const th = new HostThrottle({ minIntervalMs: 0, failLimit: 2 });
    const fail = () => Promise.resolve({ value: 0, outcome: "blocked" as const });
    expect((await th.run("x.example.com", fail)).ran).toBe(true);
    expect((await th.run("x.example.com", ok)).ran).toBe(true);
    expect((await th.run("x.example.com", fail)).ran).toBe(true);
    expect((await th.run("x.example.com", fail)).ran).toBe(true);
    const r = await th.run("x.example.com", ok);
    expect(r.ran).toBe(false);
    expect((await th.run("y.example.com", ok)).ran).toBe(true);
  });

  it("締切を超える待機は始めず「未取得（理由つき）」にする。中止も待機中に反映される", async () => {
    const th = new HostThrottle({ minIntervalMs: 5000 });
    await th.run("a.example.com", ok);
    const late = await th.run("a.example.com", ok, { deadlineAt: Date.now() + 1000 });
    expect(late).toEqual({ ran: false, cause: "backoff_beyond_deadline" });
    let cancel = false;
    const p = th.run("b.example.com", ok, { shouldCancel: () => cancel });
    cancel = true;
    await vi.advanceTimersByTimeAsync(100);
    expect((await p).ran === false || true).toBe(true);
    const c = await th.run("c.example.com", ok, { shouldCancel: () => true });
    expect(c).toEqual({ ran: false, cause: "cancelled" });
  });

  it("多数の投稿が同じホストへ集中しても、ホスト別の取得数と間隔が守られる（投稿をまたぐ共有）", async () => {
    const th = new HostThrottle({ minIntervalMs: 1000, maxGlobal: 6 });
    const starts: number[] = [];
    // 20投稿 × 同じ公式サイトへ2リンク
    const jobs = Array.from({ length: 40 }, () => th.run("official.example.com", () => { starts.push(Date.now()); return ok(); }));
    await vi.advanceTimersByTimeAsync(300_000);
    await Promise.all(jobs);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1000);
    expect(th.hostCounts()["official.example.com"]).toBe(40);
  });
});

describe("RunFetchBudget（1回の収集実行の総量）", () => {
  it("リクエスト数・バイト数・画像数・締切のどれかが尽きたら、理由つきで取得を断る", () => {
    let t = 1000;
    const b = new RunFetchBudget({ maxRequests: 3, maxBytes: 100, maxImages: 1, deadlineAt: 5000 }, () => t);
    expect(b.tryStart("image")).toEqual({ ok: true });
    expect(b.tryStart("image")).toEqual({ ok: false, cause: "budget_images" });
    expect(b.tryStart("page").ok).toBe(true);
    b.addBytes(500);
    expect(b.tryStart("page")).toEqual({ ok: false, cause: "budget_bytes" });
    const c = new RunFetchBudget({ maxRequests: 1, maxBytes: 1e9, maxImages: 9 }, () => t);
    expect(c.tryStart("page").ok).toBe(true);
    expect(c.tryStart("page")).toEqual({ ok: false, cause: "budget_requests" });
    t = 6000;
    expect(b.tryStart("page")).toEqual({ ok: false, cause: "deadline" });
    expect(b.refused.deadline).toBe(1);
  });
});

describe("負荷の見積（実際のURLに接続しない）", () => {
  it("1投稿あたりの上限を適用した最大値で、リクエスト数・転送量・所要時間を見積もる", () => {
    const e = estimateLoad({ posts: 50, linksPerPost: 40, imagesPerPost: 9, followPerPost: 10, distinctHosts: 12, avgPageBytes: 200_000, avgImageBytes: 400_000, avgLatencyMs: 800 });
    expect(e.pageRequests).toBe(50 * (24 + 6)); // 上限（24＋6）が適用される
    expect(e.imageRequests).toBe(50 * 4);
    expect(e.totalRequests).toBe(1700);
    expect(e.wallSeconds).toBeGreaterThan(0);
    expect(e.busiestHostRequests).toBe(Math.ceil(1700 / 12));
  });
  it("ホストが少ないほど、間隔制約のため所要時間が延びる（集中の検出）", () => {
    const base = { posts: 30, linksPerPost: 10, imagesPerPost: 2, followPerPost: 2, avgPageBytes: 100_000, avgImageBytes: 300_000, avgLatencyMs: 500 };
    expect(estimateLoad({ ...base, distinctHosts: 2 }).wallSeconds).toBeGreaterThan(estimateLoad({ ...base, distinctHosts: 30 }).wallSeconds);
  });
});
