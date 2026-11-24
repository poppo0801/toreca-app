import http from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HostThrottle, RunFetchBudget } from "@/lib/collector/fetch-control";
import { clearRobotsCache, fetchPublicImage, precheckImageUrl, sniffMediaType } from "./image-fetch";

// 画像は全てテスト内で生成した架空の画像（実在の画像・個人情報なし）
let png: Buffer;
let jpeg: Buffer;
let bomb: Buffer;
let rotated: Buffer;
let big: Buffer;
let server: http.Server;
let base = "";
const hits: string[] = [];

beforeAll(async () => {
  png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#fff" } }).png().toBuffer();
  jpeg = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#ccc" } }).jpeg().toBuffer();
  bomb = await sharp({ create: { width: 10000, height: 9000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer(); // 小さいファイルだが展開すると4億ピクセル
  rotated = await sharp({ create: { width: 100, height: 40, channels: 3, background: "#aaa" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "#123" } }).png().toBuffer();
  server = http.createServer((req, res) => {
    const p = req.url ?? "/";
    hits.push(p);
    const send = (status: number, type: string, body: Buffer | string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...extra });
      res.end(body);
    };
    if (p === "/robots.txt") return send(200, "text/plain", "User-agent: *\nDisallow: /private/\n");
    if (p === "/ok.png") return send(200, "image/png", png);
    if (p === "/ok.jpg") return send(200, "image/jpeg", jpeg);
    if (p === "/fake.png") return send(200, "image/png", "<html><script>alert(1)</script></html>"); // 申告はPNG・中身はHTML
    if (p === "/mismatch.png") return send(200, "image/png", jpeg); // 申告PNG・実体JPEG
    if (p === "/svg.png") return send(200, "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>");
    if (p === "/html.png") return send(200, "text/html", "<html></html>");
    if (p === "/bomb.png") return send(200, "image/png", bomb);
    if (p === "/big-bytes.png") return send(200, "image/png", Buffer.concat([png.subarray(0, 40), Buffer.alloc(6_000_000, 1)]));
    if (p === "/corrupt.png") return send(200, "image/png", Buffer.concat([png.subarray(0, 60), Buffer.from("garbage")]));
    if (p === "/rot.jpg") return send(200, "image/jpeg", rotated);
    if (p === "/large.png") return send(200, "image/png", big);
    if (p === "/private/secret.png") return send(200, "image/png", png);
    if (p === "/gone.png") return send(404, "text/plain", "no");
    if (p === "/forbidden.png") return send(403, "text/plain", "no");
    if (p === "/limited.png") return send(429, "text/plain", "slow", { "retry-after": "7" });
    if (p === "/boom.png") return send(500, "text/plain", "err");
    if (p === "/to-internal.png") return send(302, "text/plain", "", { location: "http://10.0.0.5/x.png" });
    if (p === "/loop.png") return send(302, "text/plain", "", { location: "/loop.png" });
    if (p === "/slow.png") return void setTimeout(() => send(200, "image/png", png), 3000);
    send(404, "text/plain", "nf");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  hits.length = 0;
  clearRobotsCache();
});

const T = { testOnlyAllowLoopback: true, sleep: async () => undefined };

describe("URLの事前検査（取得しないURL）", () => {
  it("個人用・署名つき・Xのページ・不正な形式は取得しない（回避しない）", () => {
    expect(precheckImageUrl("https://example.com/a.png").ok).toBe(true);
    for (const u of ["https://example.com/mypage/a.png", "https://example.com/a.png?X-Amz-Signature=abc", "https://example.com/a.png?token=zzz", "https://x.com/a/status/1/photo/1", "https://t.co/abc", "ftp://example.com/a.png", "not a url"]) {
      expect(precheckImageUrl(u).ok, u).toBe(false);
    }
  });
  it("実バイトの形式を判定する（拡張子・申告を信用しない）", () => {
    expect(sniffMediaType(png)).toBe("image/png");
    expect(sniffMediaType(jpeg)).toBe("image/jpeg");
    expect(sniffMediaType(Buffer.from("<svg></svg>"))).toBeNull();
    expect(sniffMediaType(Buffer.from("GIF89a" + "x".repeat(20)))).toBe("image/gif");
  });
});

describe("画像の取得・検証（ローカルのテストサーバーのみ・外部アクセスなし）", () => {
  it("正常な画像: 取得し、実バイトの形式・大きさ・ハッシュを記録する", async () => {
    const r = await fetchPublicImage(`${base}/ok.png`, T);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.image).toMatchObject({ mediaType: "image/png", width: 64, height: 48, resized: false });
    expect(r.image.sha256).toMatch(/^[0-9a-f]{16}$/);
    expect(Buffer.from(r.image.base64, "base64").equals(png)).toBe(true);
  });
  it("偽装レスポンス: 申告が画像でも中身がHTML／申告と実体の形式が違う／SVG／HTML は拒否", async () => {
    expect(await fetchPublicImage(`${base}/fake.png`, T)).toMatchObject({ ok: false, failure: "spoofed_type" });
    expect(await fetchPublicImage(`${base}/mismatch.png`, T)).toMatchObject({ ok: false, failure: "spoofed_type" });
    expect(await fetchPublicImage(`${base}/svg.png`, T)).toMatchObject({ ok: false, failure: "unsupported_type" });
    expect(await fetchPublicImage(`${base}/html.png`, T)).toMatchObject({ ok: false, failure: "unsupported_type" });
  });
  it("過大: バイト数の上限超過・展開爆弾（ピクセル数）は拒否し、メモリを使い切らない", async () => {
    expect(await fetchPublicImage(`${base}/big-bytes.png`, T)).toMatchObject({ ok: false, failure: "too_large_bytes" });
    expect(await fetchPublicImage(`${base}/bomb.png`, T)).toMatchObject({ ok: false, failure: "too_large_pixels" });
  });
  it("壊れたファイルは corrupt。長辺が大きい画像は縮小し、EXIFの向きを反映する", async () => {
    expect(await fetchPublicImage(`${base}/corrupt.png`, T)).toMatchObject({ ok: false, failure: "corrupt" });
    const r = await fetchPublicImage(`${base}/large.png`, T);
    expect(r.ok && r.image.resized && Math.max(r.image.width, r.image.height) <= 2000).toBe(true);
    const o = await fetchPublicImage(`${base}/rot.jpg`, T);
    expect(o.ok && o.image.width === 40 && o.image.height === 100).toBe(true); // 向き6＝90度回転
  });
  it("HTTPの失敗を分類する: 404=not_found／403=auth_required／429=rate_limited／5xxは1回だけ再試行して http_error", async () => {
    expect(await fetchPublicImage(`${base}/gone.png`, T)).toMatchObject({ failure: "not_found" });
    expect(await fetchPublicImage(`${base}/forbidden.png`, T)).toMatchObject({ failure: "auth_required" });
    hits.length = 0;
    expect(await fetchPublicImage(`${base}/limited.png`, T)).toMatchObject({ failure: "rate_limited" });
    expect(hits.filter((h) => h === "/limited.png")).toHaveLength(1); // 429 は再試行しない
    hits.length = 0;
    expect(await fetchPublicImage(`${base}/boom.png`, T)).toMatchObject({ failure: "http_error" });
    expect(hits.filter((h) => h === "/boom.png")).toHaveLength(2); // 5xx は1回だけ再試行
  });
  it("リダイレクト: 内部アドレスへの誘導は拒否・無限ループは打ち切る", async () => {
    expect(await fetchPublicImage(`${base}/to-internal.png`, T)).toMatchObject({ ok: false, failure: "blocked" });
    expect(await fetchPublicImage(`${base}/loop.png`, T)).toMatchObject({ ok: false, failure: "too_many_redirects" });
  });
  it("内部ネットワーク・メタデータ・localhost・認証情報つきのURLは、接続せずに拒否する（loopback許可なし）", async () => {
    for (const u of ["http://169.254.169.254/latest/meta-data/a.png", "http://10.0.0.1/a.png", "http://localhost/a.png", "http://[::1]/a.png", "https://user:pw@example.com/a.png", "http://example.com:8080/a.png"]) {
      const r = await fetchPublicImage(u, { sleep: async () => undefined });
      expect(r.ok, u).toBe(false);
    }
  });
  it("robots.txt が禁止するパスは取得しない（画像のリクエストを送らない）", async () => {
    const r = await fetchPublicImage(`${base}/private/secret.png`, T);
    expect(r).toMatchObject({ ok: false });
    expect(hits).not.toContain("/private/secret.png");
  });
  it("時間の上限: 遅い応答は timeout として分類する", async () => {
    const r = await fetchPublicImage(`${base}/slow.png`, { ...T, limits: { timeoutMs: 400 } });
    expect(r).toMatchObject({ ok: false, failure: "timeout" });
  }, 15_000);
  it("実行の総量・ホスト停止・中止: 取得せず「未取得（理由つき）」にする", async () => {
    const budget = new RunFetchBudget({ maxRequests: 1, maxBytes: 1e9, maxImages: 1 });
    expect((await fetchPublicImage(`${base}/ok.png`, { ...T, budget })).ok).toBe(true);
    const r2 = await fetchPublicImage(`${base}/ok.jpg`, { ...T, budget });
    expect(r2).toMatchObject({ ok: false, failure: "not_attempted", cause: "budget_requests" });
    const th = new HostThrottle({ minIntervalMs: 0, failLimit: 1 });
    await fetchPublicImage(`${base}/forbidden.png`, { ...T, throttle: th });
    const r3 = await fetchPublicImage(`${base}/ok.png`, { ...T, throttle: th });
    expect(r3).toMatchObject({ failure: "not_attempted", cause: "host_suspended" });
    expect(await fetchPublicImage(`${base}/ok.png`, { ...T, shouldCancel: () => true })).toMatchObject({ failure: "not_attempted", cause: "cancelled" });
  });
});
