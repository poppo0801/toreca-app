// @vitest-environment node
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtractorError, type LotteryExtractor } from "@/lib/ai/provider";
import { runExtraction } from "@/lib/server/lottery-extract-service";
import { checkUrl, fetchRespectingRobots, isBlockedAddress, robotsAllows, safeFetch } from "@/lib/server/safe-fetch";
import { isXHost, parseOembedHtml, parseXStatusUrl } from "@/lib/server/x-source";

describe("アドレスの検査（SSRF対策）", () => {
  it.each([
    "127.0.0.1", "127.8.8.8", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2001:db8::1", "[::1]", "not-an-ip",
  ])("%s は取得不可", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("%s は公開アドレスとして許可", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("URLの事前検査", () => {
  it.each([
    "http://localhost/", "http://LOCALHOST:80/", "http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/", "http://printer.local/", "http://intranet/",
    "http://example.com:8080/", "http://user:pw@example.com/", "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "not a url",
  ])("%s は拒否", (u) => {
    expect(checkUrl(u).ok).toBe(false);
  });
  it("通常の公開URLは許可", () => {
    expect(checkUrl("https://example.com/news?id=1").ok).toBe(true);
    expect(checkUrl("http://example.com:80/").ok).toBe(true);
  });
  it("safeFetch は内部アドレスに接続せず blocked を返す", async () => {
    const r = await safeFetch("http://169.254.169.254/latest/meta-data/");
    expect(r).toMatchObject({ ok: false, code: "blocked" });
    expect(await safeFetch("http://localhost:3000/")).toMatchObject({ ok: false, code: "blocked" });
  });
});

describe("取得処理（テスト用ローカルサーバー。ループバック許可はテスト専用オプション）", () => {
  let server: http.Server;
  let base = "";
  const hits: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><title>t</title><body>抽選のお知らせ</body></html>");
      } else if (req.url === "/redirect-internal") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      } else if (req.url === "/redirect-ok") {
        res.writeHead(302, { location: "/ok" });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("a".repeat(5000));
      } else if (req.url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      } else if (req.url === "/img") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end("x");
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 3000);
      } else if (req.url === "/forbidden") {
        res.writeHead(403);
        res.end();
      } else if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /private\nAllow: /private/open");
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<p>page</p>");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });
  const T = { testOnlyAllowLoopback: true } as const;

  it("本文を取得し、相対リダイレクトを辿る", async () => {
    const r = await safeFetch(`${base}/redirect-ok`, T);
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(r.ok && r.body).toContain("抽選のお知らせ");
  });
  it("内部アドレスへのリダイレクトは辿らない（テスト専用オプションを外した本番相当の検査）", async () => {
    // ループバック許可でも、リダイレクト先のメタデータアドレスはブロックされる必要がある
    hits.length = 0;
    const r = await safeFetch(`${base}/redirect-internal`, { testOnlyAllowLoopback: true });
    expect(r).toMatchObject({ ok: false, code: "blocked" });
  });
  it("リダイレクトの回数制限・サイズ上限・タイムアウト・許可外のContent-Type・403", async () => {
    expect(await safeFetch(`${base}/loop`, T)).toMatchObject({ ok: false, code: "too_many_redirects" });
    const big = await safeFetch(`${base}/big`, { ...T, maxBytes: 1000 });
    expect(big.ok && big.truncated).toBe(true);
    expect(big.ok && big.body.length).toBe(1000);
    expect(await safeFetch(`${base}/slow`, { ...T, timeoutMs: 300 })).toMatchObject({ ok: false, code: "timeout" });
    expect(await safeFetch(`${base}/json`, T)).toMatchObject({ ok: false, code: "unsupported_type" });
    expect(await safeFetch(`${base}/img`, T)).toMatchObject({ ok: false, code: "unsupported_type" });
    expect(await safeFetch(`${base}/forbidden`, T)).toMatchObject({ ok: false, code: "http_error", status: 403 });
  });
  it("robots.txt で禁止されたパスは取得しない（許可されたパスは取得する）", async () => {
    expect(await fetchRespectingRobots(`${base}/private/x`, T)).toMatchObject({ ok: false, code: "robots" });
    expect((await fetchRespectingRobots(`${base}/private/open`, T)).ok).toBe(true);
    expect((await fetchRespectingRobots(`${base}/ok`, T)).ok).toBe(true);
  });
});

describe("robots.txt の解釈", () => {
  it("ワイルドカード・Allow の優先・専用グループ", () => {
    const txt = "User-agent: *\nDisallow: /a/\nDisallow: /*.pdf$\nAllow: /a/pub\n\nUser-agent: TorecaApp\nDisallow: /only-us";
    expect(robotsAllows(txt, "/only-us/x")).toBe(false);
    expect(robotsAllows(txt, "/a/x")).toBe(true); // 専用グループがあれば * は使わない
    const star = "User-agent: *\nDisallow: /a/\nDisallow: /*.pdf$\nAllow: /a/pub";
    expect(robotsAllows(star, "/a/x")).toBe(false);
    expect(robotsAllows(star, "/a/pub/1")).toBe(true);
    expect(robotsAllows(star, "/docs/file.pdf")).toBe(false);
    expect(robotsAllows(star, "/docs/file.pdf.html")).toBe(true);
    expect(robotsAllows("", "/anything")).toBe(true);
  });
});

describe("Xの投稿URL", () => {
  it("x.com / twitter.com の投稿URLだけを受け付ける", () => {
    expect(parseXStatusUrl("https://x.com/shop_official/status/1234567890123?s=20")).toEqual({ user: "shop_official", id: "1234567890123" });
    expect(parseXStatusUrl("https://twitter.com/shop/status/1234567890")).toMatchObject({ user: "shop" });
    expect(parseXStatusUrl("https://x.com/shop")).toBeNull();
    expect(parseXStatusUrl("https://evil.example/shop/status/1234567890")).toBeNull();
    expect(isXHost("https://x.com/a")).toBe(true);
    expect(isXHost("https://example.com/a")).toBe(false);
  });
  it("oEmbed の blockquote から本文とリンクを取り出す", () => {
    const html = `<blockquote class="twitter-tweet"><p lang="ja" dir="ltr">【抽選販売】<br>応募は11/5まで&amp;お一人様1BOX <a href="https://t.co/abc">https://t.co/abc</a></p>&mdash; サンプル店 (@shop) <a href="https://twitter.com/shop/status/1">November 1, 2026</a></blockquote>`;
    const p = parseOembedHtml(html);
    expect(p.text).toContain("【抽選販売】\n応募は11/5まで&お一人様1BOX");
    expect(p.links).toEqual(["https://t.co/abc"]);
    expect(p.author).toContain("サンプル店");
  });
});

describe("共通パイプライン（runExtraction）", () => {
  const NOW = new Date("2026-10-28T03:00:00Z");
  const raw = {
    is_lottery_announcement: true, chain_name: "サンプル電機", store_name: "三宮店",
    products: [{ name: "商品A", quantity: 1, unit: "box" }], apply_deadline: { year: null, month: 11, day: 5, hour: 23, minute: 59 },
  };
  const seen: { text?: string }[] = [];
  const fake: LotteryExtractor = {
    engine: "mock",
    async extract(req) {
      seen.push({ text: req.text });
      return { raw, engine: "mock" };
    },
  };
  const page = async (u: string) => ({ ok: true as const, finalUrl: u, status: 200, contentType: "text/html", body: `<title>告知</title><p>${"抽選販売のお知らせです。".repeat(10)}</p>`, truncated: false });

  it("AI未設定なら案内を返し、取得もしない", async () => {
    let fetched = false;
    const r = await runExtraction({ kind: "url", url: "https://example.com" }, { extractor: null, now: NOW, fetchPage: async () => ((fetched = true), page("x")) });
    expect(r).toMatchObject({ ok: false, code: "not_configured" });
    expect(fetched).toBe(false);
  });
  it("文章・店舗URL・X投稿のどれも同じ形式の結果になる。Xのホストは店舗URL欄でもX経由で取得する", async () => {
    const t = await runExtraction({ kind: "text", text: "抽選販売のお知らせ。応募は11月5日まで" }, { extractor: fake, now: NOW });
    expect(t.ok && t.extraction.applyDeadline).toMatchObject({ date: "2026-11-05", yearAssumed: true });
    const u = await runExtraction({ kind: "url", url: "https://shop.example.invalid/n/1" }, { extractor: fake, now: NOW, fetchPage: page });
    expect(u).toMatchObject({ ok: true, kind: "url", sourceUrl: "https://shop.example.invalid/n/1" });
    const x = await runExtraction(
      { kind: "url", url: "https://x.com/shop/status/1234567890" },
      { extractor: fake, now: NOW, fetchX: async () => ({ ok: true, text: "【Xの投稿】抽選", author: "", notice: ["画像は取得できません"] }) },
    );
    expect(x).toMatchObject({ ok: true, kind: "x_url" });
    expect(x.ok && x.notices).toContain("画像は取得できません");
  });
  it("取得失敗は文章・画像入力への誘導つきで返し、Xの失敗でも全体は壊れない", async () => {
    const f = await runExtraction({ kind: "url", url: "https://shop.example.invalid" }, { extractor: fake, now: NOW, fetchPage: async () => ({ ok: false, code: "http_error", message: "ページが見つかりません" }) });
    expect(f).toMatchObject({ ok: false, code: "fetch_failed", suggest: "text" });
    const x = await runExtraction({ kind: "x_url", url: "https://x.com/a/status/1234567890" }, { extractor: fake, now: NOW, fetchX: async () => ({ ok: false, message: "取得できません" }) });
    expect(x).toMatchObject({ ok: false, code: "fetch_failed", suggest: "text" });
    const short = await runExtraction({ kind: "url", url: "https://shop.example.invalid" }, { extractor: fake, now: NOW, fetchPage: async (u) => ({ ...(await page(u)), body: "<p>JS</p>" }) });
    expect(short).toMatchObject({ ok: false, code: "fetch_failed" });
  });
  it("入力が短すぎる・抽選でない・何も読めない・AIエラーを区別する", async () => {
    expect(await runExtraction({ kind: "text", text: "短い" }, { extractor: fake, now: NOW })).toMatchObject({ ok: false, code: "empty_input" });
    const notLottery: LotteryExtractor = { engine: "mock", extract: async () => ({ raw: { ...raw, is_lottery_announcement: false }, engine: "mock" }) };
    expect(await runExtraction({ kind: "text", text: "通常販売のお知らせです。本日入荷しました" }, { extractor: notLottery, now: NOW })).toMatchObject({ ok: false, code: "not_lottery" });
    const empty: LotteryExtractor = { engine: "mock", extract: async () => ({ raw: { is_lottery_announcement: true }, engine: "mock" }) };
    expect(await runExtraction({ kind: "text", text: "何の情報もない長めの文章です。ほげほげ" }, { extractor: empty, now: NOW })).toMatchObject({ ok: false, code: "nothing_found" });
    const boom: LotteryExtractor = { engine: "anthropic", extract: async () => { throw new ExtractorError("rate_limited", "上限"); } };
    expect(await runExtraction({ kind: "text", text: "抽選販売のお知らせ。応募は11月5日まで" }, { extractor: boom, now: NOW })).toMatchObject({ ok: false, code: "rate_limited" });
    const crash: LotteryExtractor = { engine: "anthropic", extract: async () => { throw new Error("sk-ant-secret-should-not-leak"); } };
    const r = await runExtraction({ kind: "text", text: "抽選販売のお知らせ。応募は11月5日まで" }, { extractor: crash, now: NOW });
    expect(r).toMatchObject({ ok: false, code: "ai_failed" });
    expect(JSON.stringify(r)).not.toContain("sk-ant");
  });
});
