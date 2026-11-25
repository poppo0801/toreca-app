// @vitest-environment node
/** Stage 10Y: 開発限定の実ページ取得アダプタ（取得部品は差し替え。実ネットワークには出ない）。 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SafeFetchOptions, SafeFetchResult } from "@/lib/server/safe-fetch";
import { liveFetchAllowed, makeLivePublicFetch } from "./live-fetch";

vi.mock("server-only", () => ({}));
const ENV = { TOREMANE_ENV: "local", JUDGMENT_LIVE_FETCH: "allow" };
const page = (body: string, status = 200): SafeFetchResult => ({ ok: true, finalUrl: "https://shop.example/e/1", status, contentType: "text/html", body, truncated: false });
const mk = (impl: (u: string, o: SafeFetchOptions) => Promise<SafeFetchResult>, extra: Partial<Parameters<typeof makeLivePublicFetch>[0]> = {}) => {
  const slept: number[] = [];
  let t = 1_000_000;
  const f = makeLivePublicFetch({ env: ENV, fetchImpl: impl, sleep: async (ms) => { slept.push(ms); t += ms; }, now: () => t, ...extra });
  return { ...f, slept };
};

describe("実ページ取得の許可（開発限定・明示許可）", () => {
  it("開発環境かつ明示許可がなければ使えない。本番・Vercelでは常に拒否", () => {
    expect(liveFetchAllowed({}).ok).toBe(false);
    expect(liveFetchAllowed({ TOREMANE_ENV: "local" }).ok).toBe(false);
    expect(liveFetchAllowed({ ...ENV, VERCEL: "1" }).ok).toBe(false);
    expect(liveFetchAllowed({ ...ENV, NODE_ENV: "production" }).ok).toBe(false);
    expect(liveFetchAllowed(ENV).ok).toBe(true);
    expect(() => makeLivePublicFetch({ env: {} })).toThrow();
  });
});

describe("取得と失敗の区別", () => {
  it("成功: 本文はHTMLから整形し、受付終了のページは取得成功のまま終了と記録する", async () => {
    const f = mk(async () => page("<html><head><script>x</script></head><body><h1>店舗A 抽選</h1><p>受付は終了しました</p></body></html>"));
    const r = await f.fetchPage("https://shop.example/e/1");
    expect(r.ok && r.text).toContain("店舗A 抽選");
    expect(f.log[0]).toMatchObject({ outcome: "ok", endedPage: true });
  });
  it("【再現・回帰】取得サイズの上限で本文が切れたときは、切れた事実を notice で返す（成功として黙って渡さない）。切れていなければ notice は無い", async () => {
    const cut = mk(async () => ({ ...page("<html><body><h1>店舗A 抽選</h1></body></html>"), truncated: true }));
    const r = await cut.fetchPage("https://shop.example/e/1");
    expect(r.ok && r.notice).toContain("後半は確認できない");
    const whole = mk(async () => page("<html><body><h1>店舗A 抽選</h1></body></html>"));
    const w = await whole.fetchPage("https://shop.example/e/1");
    expect(w.ok && w.notice).toBeUndefined();
  });
  it("404/410=終了イベント（能力の失敗と分ける）・403=アクセス制限（迂回しない）・robots・タイムアウト・通信を区別", async () => {
    const codes: SafeFetchResult[] = [
      { ok: false, code: "http_error", status: 404, message: "" },
      { ok: false, code: "http_error", status: 403, message: "" },
      { ok: false, code: "robots", message: "" },
      { ok: false, code: "timeout", message: "" },
      { ok: false, code: "network", message: "" },
    ];
    const out: string[] = [];
    for (const [i, c] of codes.entries()) {
      const f = mk(async () => c);
      const r = await f.fetchPage(`https://h${i}.example/e/1`);
      out.push(`${r.ok ? "ok" : r.reason}:${f.log[0].outcome}`);
    }
    expect(out).toEqual(["not_public:ended_http", "login_required:auth_required", "robots:robots", "timeout:timeout", "failed:network"]);
  });
  it("ログインが必要な短いページは停止する", async () => {
    const f = mk(async () => page("<html><body>ログインが必要です</body></html>"));
    const r = await f.fetchPage("https://shop.example/e/9");
    expect(r).toEqual({ ok: false, reason: "login_required" });
  });
});

describe("安全な範囲だけ（迂回しない）", () => {
  it("X・短縮URL・会員用/ログイン用のパス・内部アドレスは取得に出ない", async () => {
    const impl = vi.fn(async () => page("<html>x</html>"));
    const f = mk(impl);
    for (const u of ["https://x.com/shop/status/1", "https://t.co/abc", "https://shop.example/mypage/orders", "https://shop.example/login", "http://127.0.0.1/", "http://169.254.169.254/latest", "file:///etc/passwd"]) {
      const r = await f.fetchPage(u);
      expect(r.ok, u).toBe(false);
    }
    expect(impl).not.toHaveBeenCalled();
  });
  it("リダイレクトは1回ずつ辿り、毎回 取得部品（robots・SSRF検査つき）を通す。X へのリダイレクトは止める", async () => {
    const seen: string[] = [];
    const redir = (to: string): SafeFetchResult => ({ ok: true, finalUrl: to, status: 302, contentType: "", body: "", truncated: false });
    const f = mk(async (u, o) => {
      seen.push(u);
      expect(o.noFollow).toBe(true);
      return u.endsWith("/a") ? redir("https://b.example/b") : u.endsWith("/b") ? redir("https://c.example/c") : page("<html><body>本文です</body></html>");
    });
    const r = await f.fetchPage("https://a.example/a");
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["https://a.example/a", "https://b.example/b", "https://c.example/c"]);
    expect(f.log[0].redirects).toBe(2);
    const g = mk(async () => redir("https://x.com/shop/status/1"));
    expect((await g.fetchPage("https://a.example/a")).ok).toBe(false);
    expect(g.log[0].outcome).toBe("denied_target");
  });
  it("同じホストへは間隔をあける。2回続けて失敗したホストへは行かない。1実行の取得数に上限", async () => {
    const f = mk(async () => page("<html><body>本文です</body></html>"));
    await f.fetchPage("https://a.example/1");
    await f.fetchPage("https://a.example/2");
    expect(f.slept.filter((x) => x > 0).length).toBeGreaterThanOrEqual(1);
    const impl = vi.fn(async (): Promise<SafeFetchResult> => ({ ok: false, code: "network", message: "" }));
    const g = mk(impl);
    await g.fetchPage("https://z.example/1");
    await g.fetchPage("https://z.example/2");
    const third = await g.fetchPage("https://z.example/3");
    expect(third.ok).toBe(false);
    expect(impl).toHaveBeenCalledTimes(2);
    expect(g.log[2].outcome).toBe("suppressed_host");
    const h = mk(async () => page("<html><body>本文です</body></html>"), { maxFetches: 2 });
    await h.fetchPage("https://q.example/1");
    await h.fetchPage("https://r.example/1");
    expect((await h.fetchPage("https://s.example/1")).ok).toBe(false);
    expect(h.log[2].outcome).toBe("limit");
  });
});

describe("通常の画面・収集・cron から読み込まれない（静的確認）", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
  it("live-fetch を import するのは、評価の実行コード（*.test.ts）と、本番シャドーの調査ジョブ（shadow/proposal-job.ts。多重の本番ゲートの後）だけ", () => {
    const users = walk("src").filter((f) => !f.endsWith("live-fetch.ts") && !f.endsWith("live-fetch.test.ts") && /xsource\/live-fetch|\.\/live-fetch/.test(readFileSync(f, "utf8")));
    for (const f of users) expect(f.replace(/\\/g, "/"), f).toMatch(/\.test\.ts$|src\/lib\/server\/shadow\/proposal-job\.ts$/);
  });
  it("本番シャドーの取得許可は、本番かつ明示許可のときだけ。開発の許可とは独立で、印つきの関数だけが本番シャドーの生成に渡せる", async () => {
    const { shadowLiveFetchAllowed, makeShadowLivePublicFetch } = await import("./live-fetch");
    const { isShadowTool } = await import("./shadow-tool-mark");
    expect(shadowLiveFetchAllowed({}).ok).toBe(false);
    expect(shadowLiveFetchAllowed({ VERCEL_ENV: "production" }).ok).toBe(false);
    expect(shadowLiveFetchAllowed({ SHADOW_LIVE_FETCH: "allow" }).ok).toBe(false);
    expect(shadowLiveFetchAllowed({ VERCEL_ENV: "production", SHADOW_LIVE_FETCH: "allow" }).ok).toBe(true);
    expect(() => makeShadowLivePublicFetch({ env: { TOREMANE_ENV: "local", JUDGMENT_LIVE_FETCH: "allow" } })).toThrow(); // 開発の許可では本番シャドーの取得は作れない
    expect(liveFetchAllowed({ VERCEL_ENV: "production", SHADOW_LIVE_FETCH: "allow" }).ok).toBe(false); // 逆も同様
    const f = makeShadowLivePublicFetch({ env: { VERCEL_ENV: "production", SHADOW_LIVE_FETCH: "allow" }, fetchImpl: async () => ({ ok: true, finalUrl: "https://shop.example/e/1", status: 200, contentType: "text/html", body: "<html><body>x</body></html>", truncated: false }), sleep: async () => undefined });
    expect(isShadowTool(f.fetchPage)).toBe(true);
    expect(isShadowTool(async () => ({ ok: false }))).toBe(false);
  });
});
