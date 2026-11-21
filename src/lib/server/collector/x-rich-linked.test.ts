// @vitest-environment node
/** Stage 10J: 投稿内のリンク先の本文を、解析用の本文とは別に返す（保存用）。架空データ・取得は注入。 */
import { describe, expect, it, vi } from "vitest";
import { enrichXPost } from "./x-rich";

vi.mock("server-only", () => ({}));

const html = (body: string) => `<html><head><title>架空店の抽選</title></head><body><main>${body}</main></body></html>`;
const ok = (body: string) => ({ ok: true as const, finalUrl: "https://shop.example.com/l/1", status: 200, contentType: "text/html", body: html(body), truncated: false });

describe("enrichXPost: リンク先の本文を保存用に返す", () => {
  it("リンク先が取得できたとき、解析用の本文に統合しつつ、リンク先の本文とURLを別に返す", async () => {
    const r = await enrichXPost({ text: "抽選のお知らせ", links: ["https://shop.example.com/l/1"], images: [] }, { fetchPage: async () => ok("架空TCG 拡張パックの抽選販売の詳細です。応募期間は2099年4月1日から8日まで。当選発表は4月12日です。") });
    expect(r.linkedPage).toBe(true);
    expect(r.linkUrl).toBe("https://shop.example.com/l/1");
    expect(r.linkedPageText).toContain("応募期間");
    expect(r.text).toContain("リンク先の案内");
  });
  it("取得できない・短すぎるときは linkedPageText を返さない（取得できたことにしない）", async () => {
    const ng = await enrichXPost({ text: "抽選のお知らせ", links: ["https://shop.example.com/l/1"], images: [] }, { fetchPage: async () => ({ ok: false as const, code: "robots" as const, message: "x" }) });
    expect(ng.linkedPage).toBe(false);
    expect(ng.linkedPageText).toBeUndefined();
    const short = await enrichXPost({ text: "抽選", links: ["https://shop.example.com/l/1"], images: [] }, { fetchPage: async () => ok("短い") });
    expect(short.linkedPageText).toBeUndefined();
  });
});
