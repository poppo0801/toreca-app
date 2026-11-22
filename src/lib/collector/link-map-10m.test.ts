// @vitest-environment node
/** Stage 10M: 短縮URL→展開後URLの対応（まとめ投稿の項目ごとの応募先）。長い投稿（note_tweet）のリンクも拾う。架空データのみ。 */
import { describe, expect, it, vi } from "vitest";
import { buildEvidence, evidenceFromLastGood } from "./evidence";
import { parseXPosts } from "./x-posts";

vi.mock("server-only", () => ({}));

const tweet = {
  data: [
    {
      id: "123456789",
      text: "まとめ（途中まで） https://t.co/aaa",
      note_tweet: { text: "まとめ（全文） https://t.co/aaa https://t.co/bbb https://t.co/ccc", entities: { urls: [{ url: "https://t.co/bbb", expanded_url: "https://shop-b.example.com/lottery/1" }, { url: "https://t.co/ccc", unwound_url: "https://shop-c.example.com/l/2", expanded_url: "https://t.co/ccc" }] } },
      created_at: "2099-01-01T00:00:00Z",
      author_id: "9",
      entities: { urls: [{ url: "https://t.co/aaa", expanded_url: "https://shop-a.example.com/lottery/0" }, { url: "https://t.co/zzz", expanded_url: "http://insecure.example.com/x" }] },
    },
  ],
};

describe("投稿のリンク: 本文の entities と、長い投稿（note_tweet）の entities の両方から、短縮→展開の対応を作る", () => {
  it("展開後のリンクと対応表に、長い投稿の分も含まれる（https のみ・t.co のみ・重複なし）", () => {
    const [p] = parseXPosts(tweet, "sample");
    expect(p.links).toEqual(["https://shop-a.example.com/lottery/0", "https://shop-b.example.com/lottery/1", "https://shop-c.example.com/l/2"]);
    expect(p.linkMap).toEqual([
      { short: "https://t.co/aaa", url: "https://shop-a.example.com/lottery/0" },
      { short: "https://t.co/bbb", url: "https://shop-b.example.com/lottery/1" },
      { short: "https://t.co/ccc", url: "https://shop-c.example.com/l/2" },
    ]);
  });
  it("保存原文に linkMap（追加項目）として保存され、読み戻せる。無い記録は従来どおり。ハッシュは本文のみ", () => {
    const post = { text: "まとめ https://t.co/aaa", links: [] as string[], linkMap: [{ short: "https://t.co/aaa", url: "https://shop-a.example.com/x" }, { short: "http://bad", url: "http://insecure" }] };
    const a = buildEvidence({ url: "https://x.example/1", kind: "x_post", post: { text: post.text, links: [] } }, "2099-01-01T00:00:00Z");
    const b = buildEvidence({ url: "https://x.example/1", kind: "x_post", post }, "2099-01-01T00:00:00Z");
    expect(b?.linkMap).toEqual([{ short: "https://t.co/aaa", url: "https://shop-a.example.com/x" }]);
    expect(a && "linkMap" in a).toBe(false);
    expect(b?.hash).toBe(a?.hash);
    expect(evidenceFromLastGood({ evidence: b })?.linkMap).toHaveLength(1);
    expect(evidenceFromLastGood({ evidence: { ...b, linkMap: [1, "x"] } })?.linkMap).toBeUndefined();
  });
});
