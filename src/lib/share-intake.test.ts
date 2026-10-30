import { describe, expect, it } from "vitest";
import { parseSharedPost, safeNext, shareLinkPrefix } from "@/lib/share-intake";
import { xPostId } from "@/lib/ai-job";

describe("共有されたX投稿URLの検証", () => {
  it.each([
    ["https://x.com/shop_abc/status/1234567890123456789", "shop_abc", "1234567890123456789"],
    ["https://twitter.com/shop_abc/status/1234567890?s=20&t=AbCdEf", "shop_abc", "1234567890"],
    ["https://mobile.twitter.com/Shop_1/statuses/9876543210", "Shop_1", "9876543210"],
    ["https://www.x.com/shop/status/1234567890/photo/1", "shop", "1234567890"],
    ["http://x.com/shop/status/1234567890", "shop", "1234567890"],
  ])("%s は受け付け、標準の形にそろえる", (url, handle, id) => {
    const r = parseSharedPost({ url });
    expect(r).toMatchObject({ ok: true, postId: id, handle, url: `https://x.com/${handle}/status/${id}` });
    expect(xPostId((r as { url: string }).url)).toBe(id); // 既存のX解析・重複判定にそのまま渡せる
  });

  it("/i/status/ID 形式も受け付ける。文章付きの共有（本文＋URL）からURLを取り出す", () => {
    expect(parseSharedPost({ url: "https://x.com/i/web/status/1234567890" })).toMatchObject({ ok: true, url: "https://x.com/i/status/1234567890", handle: null });
    const r = parseSharedPost({ text: "【ポケカ抽選】応募は明日まで！ https://x.com/shop/status/1234567890?s=46 (拡散希望)" });
    expect(r).toMatchObject({ ok: true, postId: "1234567890" });
    // urlが空でも、textにあれば使う。両方あるときはurlを優先
    expect(parseSharedPost({ url: "https://x.com/a/status/1111111111", text: "https://x.com/b/status/2222222222" })).toMatchObject({ postId: "1111111111" });
  });

  it.each([
    [{}, "共有されたURLがありません"],
    [{ url: "   " }, "共有されたURLがありません"],
    [{ text: "URLのない文章です" }, "URLが見つかりません"],
    [{ url: "https://example.com/shop/status/1234567890" }, "投稿のURLではありません"],
    [{ url: "https://x.com.evil.example/shop/status/1234567890" }, "投稿のURLではありません"],
    [{ url: "https://evil.example/?u=https://x.com/shop/status/1234567890" }, "投稿のURLではありません"],
    [{ url: "https://x.com/shop" }, "投稿ごとのURL"],
    [{ url: "https://x.com/shop/status/abc" }, "投稿ごとのURL"],
    [{ url: "https://x.com/home" }, "投稿ごとのURL"],
    [{ url: "javascript:alert(1)" }, "URLが見つかりません"],
    [{ url: "ftp://x.com/shop/status/1234567890" }, "URLが見つかりません"],
    [{ url: "https://user:pw@x.com/shop/status/1234567890" }, "受け付けられません"],
    [{ url: "https://x.com:8443/shop/status/1234567890" }, "受け付けられません"],
    [{ url: "https://x.com/shop/status/1234567890" + "a".repeat(2100) }, "長すぎます"],
  ])("%j は拒否する", (input, msg) => {
    const r = parseSharedPost(input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain(msg);
  });

  it("ログイン後の戻り先は共有の入口だけ（他は既定へ）。ショートカット用URLの前半を作る", () => {
    expect(safeNext("/share?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1234567890")).toContain("/share?url=");
    expect(safeNext("/share")).toBe("/share");
    for (const bad of ["https://evil.example/", "//evil.example", "/settings", "/share/../settings", "/sharex", "/share\evil", "/share\n", undefined, null, 5]) expect(safeNext(bad)).toBe("/lotteries");
    expect(shareLinkPrefix("https://toreca-app.vercel.app/")).toBe("https://toreca-app.vercel.app/share?url=");
  });
});
