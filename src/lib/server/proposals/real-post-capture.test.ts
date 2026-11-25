// @vitest-environment node
/**
 * 実投稿の複数リンク案件の資料化（差し替えた「模擬のWeb」だけ。実際のネットワークには出ない・費用0）。
 * 検証: 実リクエストの総数（robots・リダイレクトの付随を含む）の計数と上限／t.co の Location・meta refresh／短縮URL→宛先の対応／ホップごとの検査・間隔／
 *       http・危険な宛先・ログイン壁・robots拒否・403/404・JSのみ の扱い／同じ内容の2ページを2機会と数えない／少ないリンクの投稿を先に処理
 */
import { describe, expect, it, vi } from "vitest";
import { validateRealPostCases } from "@/lib/judgment/xsource/compare-eval";
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from "@/lib/server/safe-fetch";
import { captureRealPosts } from "./real-post-capture";

vi.mock("server-only", () => ({}));

const body = (title: string, extra = "") => `<html><title>${title}</title><body><p>【${title}】拡張パックの抽選受付ページです。応募期間と応募方法を記載しています。お一人様1回まで。${extra}</p></body></html>`;
type Route = { status: number; type?: string; body?: string; location?: string };
/** 模擬のWeb: URL→応答。safeFetch と同じ契約（beforeRequest/onResponse を呼ぶ・noFollow は最初の Location を返す）で、送った全リクエストを記録する */
function web(routes: Record<string, Route>, real?: (u: string, o: SafeFetchOptions) => Promise<SafeFetchResult>) {
  const log: { url: string; at: number }[] = [];
  let clock = 0;
  const fetchImpl = async (url: string, o: SafeFetchOptions): Promise<SafeFetchResult> => {
    const r = routes[url];
    if (!r) {
      if (real) return real(url, o); // 模擬に無いURLは実の safeFetch（SSRF検査でネットワークの前に拒否される）
      return { ok: false, code: "http_error", status: 404, message: "nf" };
    }
    if (o.beforeRequest?.(new URL(url)) === false) return { ok: false, code: "blocked", message: "limit" };
    log.push({ url, at: clock });
    o.onResponse?.({ host: new URL(url).hostname, status: r.status, bytes: (r.body ?? "").length });
    if (r.status >= 300 && r.status < 400) return { ok: true, finalUrl: r.location!, status: r.status, contentType: "", body: "", truncated: false };
    if (r.status >= 400) return { ok: false, code: "http_error", status: r.status, message: "x" };
    return { ok: true, finalUrl: url, status: r.status, contentType: r.type ?? "text/html", body: r.body ?? "", truncated: false };
  };
  return { fetchImpl, log, time: { now: () => clock, sleep: async (ms: number) => void (clock += ms) } };
}
const post = (id: string, shorts: string[]) => ({ id, postUrl: `https://x.com/official/status/${id}`, text: `《A》 《B》 《C》 ${shorts.join(" ")}`, capturedAt: "2026-11-20T00:00:00Z" });
const robotsOk = (host: string): Record<string, Route> => ({ [`https://${host}/robots.txt`]: { status: 200, type: "text/plain", body: "User-agent: *\nDisallow: /private/\n" } });
const base = (): Record<string, Route> => ({
  "https://t.co/robots.txt": { status: 200, type: "text/plain", body: "User-agent: *\nDisallow: /\n" }, // t.co は解決専用（記録のみ）
  "https://t.co/a": { status: 301, location: "https://shop-a.example.invalid/e/1" },
  "https://t.co/b": { status: 301, location: "https://shop-b.example.invalid/e/2" },
  "https://t.co/c": { status: 301, location: "https://shop-c.example.invalid/e/3" },
  ...robotsOk("shop-a.example.invalid"),
  ...robotsOk("shop-b.example.invalid"),
  ...robotsOk("shop-c.example.invalid"),
  "https://shop-a.example.invalid/e/1": { status: 200, body: body("新宿本店") },
  "https://shop-b.example.invalid/e/2": { status: 200, body: body("渋谷店") },
  "https://shop-c.example.invalid/e/3": { status: 200, body: body("大阪店") },
});

describe("実リクエストの計数（robots・リダイレクトを含む）と上限", () => {
  it("送った全てのHTTPリクエストを内訳つきで数える。数が、模擬のWebが実際に受けた数と一致する", async () => {
    const w = web({ ...base(), "https://shop-b.example.invalid/e/2": { status: 302, location: "https://cdn-b.example.invalid/p/2" }, ...robotsOk("cdn-b.example.invalid"), "https://cdn-b.example.invalid/p/2": { status: 200, body: body("渋谷店") } });
    const { cases, report } = await captureRealPosts({ rows: [post("1111111111111", ["https://t.co/a", "https://t.co/b", "https://t.co/c"])], fetchImpl: w.fetchImpl, ...w.time });
    expect(report.requests.total).toBe(w.log.length); // 数え漏れが無い
    // t.co の robots(1)＋展開(3)＋robots(shop-a, shop-b, cdn-b, shop-c の4)＋ページ(3)＋リダイレクト先(1)＋shop-bの最初(1)
    expect(report.requests.byPurpose).toMatchObject({ expand: 3 });
    expect(report.requests.byPurpose.robots).toBe(1 + 4);
    expect(report.requests.byPurpose.redirect).toBe(1);
    expect(report.requests.total).toBe(5 + 3 + 3 + 1);
    expect(report.shortenerRobots).toBe("disallows_root");
    expect(report.shortLinks).toEqual({ total: 3, resolved: 3, failed: 0 });
    expect(cases).toHaveLength(1);
    expect(cases[0].linkMap).toEqual([{ short: "https://t.co/a", url: "https://shop-a.example.invalid/e/1" }, { short: "https://t.co/b", url: "https://shop-b.example.invalid/e/2" }, { short: "https://t.co/c", url: "https://shop-c.example.invalid/e/3" }]); // 短縮URL→宛先の対応
    expect(validateRealPostCases(cases).ok).toBe(true);
  });
  it("上限（総リクエスト）を超えるリクエストは送らない。付随のrobots・リダイレクトを含めて止まり、止めた理由と未取得を残す", async () => {
    const w = web(base());
    const { report } = await captureRealPosts({ rows: [post("2222222222222", ["https://t.co/a", "https://t.co/b", "https://t.co/c"])], fetchImpl: w.fetchImpl, maxRequests: 6, ...w.time });
    expect(w.log.length).toBeLessThanOrEqual(6);
    expect(report.requests.total).toBeLessThanOrEqual(6);
    expect(report.stoppedBy).toBe("request_budget");
    expect(report.failures.request_budget).toBeGreaterThan(0);
  });
  it("ホスト別の間隔（1.5秒）を、同じホストへの連続リクエストで守る（別ホストへのリダイレクトも同じ）", async () => {
    const w = web(base());
    await captureRealPosts({ rows: [post("3333333333333", ["https://t.co/a", "https://t.co/b", "https://t.co/c"])], fetchImpl: w.fetchImpl, ...w.time });
    const byHost = new Map<string, number[]>();
    for (const l of w.log) byHost.set(new URL(l.url).hostname, [...(byHost.get(new URL(l.url).hostname) ?? []), l.at]);
    const tco = byHost.get("t.co")!;
    expect(tco.length).toBe(4);
    for (let i = 1; i < tco.length; i++) expect(tco[i] - tco[i - 1]).toBeGreaterThanOrEqual(1500);
    for (const [h, ts] of byHost) for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1], h).toBeGreaterThanOrEqual(1500);
  });
});

describe("短縮リンクの解決・ホップごとの検査・取得しないもの", () => {
  it("t.co が 301 ではなく HTML（meta refresh）で宛先を返しても解決できる", async () => {
    const r = { ...base(), "https://t.co/a": { status: 200, type: "text/html", body: '<noscript><META http-equiv="refresh" content="0;URL=https://shop-a.example.invalid/e/1"></noscript>' } };
    const w = web(r);
    const { report } = await captureRealPosts({ rows: [post("4444444444444", ["https://t.co/a", "https://t.co/b"])], fetchImpl: w.fetchImpl, ...w.time });
    expect(report.shortLinks.resolved).toBe(2);
  });
  it("http の宛先・内部/危険なアドレスへの誘導・リダイレクトの輪・ログイン壁・robots拒否・403・404・JSのみ を取得せず、理由を残す。危険な宛先にはネットワーク接続しない", async () => {
    const r: Record<string, Route> = {
      ...base(),
      "https://t.co/a": { status: 301, location: "http://insecure.example.invalid/e/1" }, // http のみ
      "https://t.co/b": { status: 301, location: "https://169.254.169.254/latest/meta-data/" }, // メタデータ（実の safeFetch が接続前に拒否）
      "https://t.co/c": { status: 301, location: "https://loop.example.invalid/a" },
      "https://t.co/d": { status: 301, location: "https://login.example.invalid/e/4" },
      "https://t.co/e": { status: 301, location: "https://closed.example.invalid/private/x" },
      "https://t.co/f": { status: 301, location: "https://forbidden.example.invalid/e/6" },
      "https://t.co/g": { status: 301, location: "https://gone.example.invalid/e/7" },
      "https://t.co/h": { status: 301, location: "https://spa.example.invalid/e/8" },
      ...robotsOk("loop.example.invalid"),
      "https://loop.example.invalid/a": { status: 302, location: "https://loop.example.invalid/b" },
      "https://loop.example.invalid/b": { status: 302, location: "https://loop.example.invalid/c" },
      "https://loop.example.invalid/c": { status: 302, location: "https://loop.example.invalid/d" },
      "https://loop.example.invalid/d": { status: 302, location: "https://loop.example.invalid/a" },
      ...robotsOk("login.example.invalid"),
      "https://login.example.invalid/e/4": { status: 200, body: "<html><body>ログイン メールアドレス パスワード を入力してください</body></html>" },
      ...robotsOk("closed.example.invalid"),
      ...robotsOk("forbidden.example.invalid"),
      "https://forbidden.example.invalid/e/6": { status: 403 },
      ...robotsOk("gone.example.invalid"),
      "https://gone.example.invalid/e/7": { status: 404 },
      ...robotsOk("spa.example.invalid"),
      "https://spa.example.invalid/e/8": { status: 200, body: "<html><body><div id=app></div></body></html>" },
    };
    const w = web(r, (u, o) => safeFetch(u, o)); // 模擬に無い宛先（メタデータ）は実の safeFetch
    const shorts = ["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => `https://t.co/${x}`);
    const { cases, report } = await captureRealPosts({ rows: [post("5555555555555", shorts)], fetchImpl: w.fetchImpl, ...w.time });
    expect(cases).toEqual([]);
    expect(report.failures).toMatchObject({ insecure_http: 1, not_fetchable_class: 1, redirect_loop: 1, login_wall: 1, robots: 1, auth_required: 1, not_found: 1, too_short_or_js_only: 1 });
    expect(w.log.some((l) => l.url.includes("169.254"))).toBe(false); // 危険な宛先へは届かない（リンクの選別が先に除き、さらに実の safeFetch も接続前に拒否する）
    expect(await safeFetch("https://169.254.169.254/latest/meta-data/")).toMatchObject({ ok: false, code: "blocked" });
    expect(w.log.some((l) => l.url.includes("insecure.example.invalid"))).toBe(false); // http は取得しない
    expect(w.log.some((l) => l.url.includes("/private/x"))).toBe(false); // robots が禁止するパスは取得しない
  });
  it("同じ内容のページが2つあっても、独立した応募機会は1つ（案件にならない）。内容が違えば別の機会", async () => {
    const r = { ...base(), "https://shop-b.example.invalid/e/2": { status: 200, body: body("新宿本店") } }; // a と b が同一内容
    const w = web(r);
    const { cases, pages, report } = await captureRealPosts({ rows: [post("6666666666666", ["https://t.co/a", "https://t.co/b"])], fetchImpl: w.fetchImpl, ...w.time });
    expect(pages.map((p) => p.sameContentAs)).toEqual([null, 0]);
    expect(cases).toEqual([]);
    expect(report.perPost[0].sameContentPairs).toBe(1);
  });
  it("少ないリンクの投稿から先に処理する（予算の範囲で完成する案件を最大にする）。リンクが1つの投稿は対象外", async () => {
    const w = web({ ...base(), "https://t.co/d": { status: 301, location: "https://shop-a.example.invalid/e/1" } });
    const { report } = await captureRealPosts({ rows: [post("7777777777777", ["https://t.co/a", "https://t.co/b", "https://t.co/c"]), post("8888888888888", ["https://t.co/a", "https://t.co/b"]), { id: "9", postUrl: "https://x.com/o/status/9999999", text: "one https://t.co/a", capturedAt: "x" }], fetchImpl: w.fetchImpl, ...w.time });
    expect(report.withMultiLinks).toBe(2);
    expect(report.perPost.map((p) => p.shortLinks)).toEqual([2, 3]);
  });
});
