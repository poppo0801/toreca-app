import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBookmarkPage } from "@/lib/server/collector/bookmarks";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.restoreAllMocks());

describe("Stage 6I: ブックマークの取得（X API）", () => {
  it("ユーザーのアクセストークンで公式APIを呼び、画像付き投稿・引用元・リンク・次ページを読む", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json(200, {
        data: [
          { id: "111", text: "抽選のお知らせ", author_id: "9", created_at: "2026-11-04T00:00:00Z", attachments: { media_keys: ["m1"] }, entities: { urls: [{ expanded_url: "https://example.com/chusen" }] }, referenced_tweets: [{ type: "quoted", id: "222" }] },
        ],
        includes: {
          media: [{ media_key: "m1", type: "photo", url: "https://pbs.twimg.com/media/abc.jpg" }],
          users: [{ id: "9", username: "shop_a", name: "TSUTAYA 竹原店" }, { id: "8", username: "orig", name: "元" }],
          tweets: [{ id: "222", text: "引用元の本文", author_id: "8", created_at: "2026-11-03T00:00:00Z" }],
        },
        meta: { next_token: "NEXT1" },
      }),
    );
    const r = await fetchBookmarkPage("user-access-token", "12345", { max: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.posts[0]).toMatchObject({ id: "111", url: "https://x.com/shop_a/status/111", images: ["https://pbs.twimg.com/media/abc.jpg"], links: ["https://example.com/chusen"], quoted: { id: "222", username: "orig", text: "引用元の本文" } });
    expect(r.nextToken).toBe("NEXT1");
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/api\.x\.com\/2\/users\/12345\/bookmarks\?/);
    expect(String(url)).toContain("max_results=5");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer user-access-token" });
  });
  it("2ページ目は pagination_token を付ける。ユーザーIDが不正なら呼ばない", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(200, { data: [], meta: {} }));
    await fetchBookmarkPage("t", "12345", { max: 200, token: "TOK" });
    expect(String(f.mock.calls[0][0])).toContain("pagination_token=TOK");
    expect(String(f.mock.calls[0][0])).toContain("max_results=100");
    f.mockClear();
    expect(await fetchBookmarkPage("t", "../evil", { max: 5 })).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });
  it("認証エラー(401)は再連携が必要。403・429・通信失敗は区別し、トークンを文言に含めない", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(json(401, { title: "Unauthorized", detail: "Bearer secret-token-zzz" }));
    const a = await fetchBookmarkPage("secret-token-zzz", "1", { max: 5 });
    expect(a).toMatchObject({ ok: false, code: "reauth" });
    f.mockResolvedValueOnce(json(403, { detail: "forbidden secret-token-zzz" }));
    const b = await fetchBookmarkPage("secret-token-zzz", "1", { max: 5 });
    expect(b).toMatchObject({ ok: false, code: "forbidden" });
    f.mockResolvedValueOnce(json(429, {}));
    expect(await fetchBookmarkPage("t", "1", { max: 5 })).toMatchObject({ ok: false, code: "rate_limited" });
    f.mockRejectedValueOnce(new Error("boom"));
    expect(await fetchBookmarkPage("t", "1", { max: 5 })).toMatchObject({ ok: false, code: "network" });
    expect(JSON.stringify([a, b])).not.toContain("secret-token-zzz");
  });
});
