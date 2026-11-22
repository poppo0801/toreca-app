// @vitest-environment node
/** Stage 10W: 応募URLの根拠の保存（X APIのentity → 収集の保存形式 → 項目ごとの応募先URLと出所）。架空の投稿データ。 */
import { describe, expect, it } from "vitest";
import { buildEvidence, evidenceFromLastGood } from "@/lib/collector/evidence";
import { parseXPosts } from "@/lib/collector/x-posts";
import { deriveLinkMap, buildLinkEvidence } from "./link-evidence";
import { planXPost, type StoredXPost } from "./x-origin";
import { parseListItems } from "../list-items";

const TEXT = "【抽選まとめ】 《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/22(日)23:59 https://t.co/aaa111 《渋谷西口店（東京）- 1件》 ・拡張パック 抽選 11/22(日)23:59 https://t.co/bbb222";
const api = (entities: object, text = TEXT) => ({ data: [{ id: "100", text, author_id: "1", created_at: "2026-11-22T00:00:00Z", ...entities }], includes: { users: [{ id: "1", username: "shop" }] } });
const urls = [{ url: "https://t.co/aaa111", expanded_url: "https://shop.example/shinjuku" }, { url: "https://t.co/bbb222", expanded_url: "https://shop.example/shibuya", unwound_url: "https://shop.example/shibuya?u=1" }];

describe("X APIのentity → 収集の保存 → 項目別の応募先URL（新規収集の経路）", () => {
  it("entities.urls の 短縮→展開 を保存し、再読込しても失わず、項目ごとの応募先として使える（unwound_url を優先）", () => {
    const [p] = parseXPosts(api({ entities: { urls } }), "shop");
    expect(p.linkMap).toEqual([{ short: "https://t.co/aaa111", url: "https://shop.example/shinjuku" }, { short: "https://t.co/bbb222", url: "https://shop.example/shibuya?u=1" }]);
    const ev = buildEvidence({ url: p.url, kind: "x_post", post: { text: p.text, links: p.links, linkMap: p.linkMap, images: [] } }, "2026-11-22T00:00:00Z")!;
    expect(ev.linkMap).toHaveLength(2);
    const back = evidenceFromLastGood({ evidence: JSON.parse(JSON.stringify(ev)) })!; // 保存→読み込み
    const plan = planXPost({ postId: p.id, text: back.text, links: back.links, linkMap: back.linkMap, recordedAt: back.fetchedAt });
    expect(plan.items.map((i) => [i.status, i.scopedUrls])).toEqual([["url_from_item", ["https://shop.example/shinjuku"]], ["url_from_item", ["https://shop.example/shibuya?u=1"]]]);
    expect(plan.items[0].linkEvidence[0]).toMatchObject({ method: "x_api_entity", outcome: "expanded", shortUrl: "https://t.co/aaa111", expandedUrl: "https://shop.example/shinjuku", reason: null });
    expect(plan.items[0].linkEvidence[0].position).toBe(TEXT.indexOf("https://t.co/aaa111")); // 本文中の位置
    expect(plan.items[0].linkEvidence[0].itemRange.end).toBeGreaterThan(plan.items[0].linkEvidence[0].itemRange.start);
  });
  it("長い投稿（note_tweet）の entity も取り込む", () => {
    const [p] = parseXPosts(api({ note_tweet: { text: TEXT, entities: { urls } } }), "shop");
    expect(p.linkMap).toHaveLength(2);
  });
  it("https でない展開結果は取り込まない。投稿自身の画像リンクは外部リンクに含めない", () => {
    const [p] = parseXPosts(api({ entities: { urls: [{ url: "https://t.co/aaa111", expanded_url: "http://insecure.example/a" }, { url: "https://t.co/zzz", expanded_url: "https://x.com/shop/status/100/photo/1" }, { url: "https://t.co/aaa111", expanded_url: "https://shop.example/dup" }] } }), "shop");
    expect(p.linkMap?.map((m) => [m.short, m.url])).toEqual([["https://t.co/zzz", "https://x.com/shop/status/100/photo/1"], ["https://t.co/aaa111", "https://shop.example/dup"]]); // http（暗号化なし）は取り込まない。画像のt.co は短縮対応として残るが…
    expect(p.links).toEqual(["https://shop.example/dup"]); // 画像リンク（status/…/photo/1）は外部リンクに含めない
  });
});

describe("保存済みの投稿（linkMap なし）からの復元は、一意に決まる場合だけ", () => {
  const base = { postId: "p", links: [] as string[], recordedAt: "2026-11-22T00:00:00Z" };
  it("本文の短縮URLがちょうど1つ・保存された外部リンクがちょうど1つ → stored_unique_pair（entity由来ではないと記録）", () => {
    const d = deriveLinkMap({ ...base, text: "【店舗A】拡張パック抽選 https://t.co/one111", links: ["https://shop.example/a", "https://x.com/shop/status/1"] });
    expect(d.linkMap).toEqual([{ short: "https://t.co/one111", url: "https://shop.example/a" }]);
    expect(d.methods.get("https://t.co/one111")).toBe("stored_unique_pair");
  });
  it("曖昧なとき（短縮URLが複数／外部リンクが複数／0）は復元しない（推測で埋めない）", () => {
    expect(deriveLinkMap({ ...base, text: "a https://t.co/a1 b https://t.co/b2", links: ["https://shop.example/a"] }).linkMap).toEqual([]);
    expect(deriveLinkMap({ ...base, text: "a https://t.co/a1", links: ["https://shop.example/a", "https://shop.example/b"] }).linkMap).toEqual([]);
    expect(deriveLinkMap({ ...base, text: "a https://t.co/a1", links: [] }).linkMap).toEqual([]);
    expect(deriveLinkMap({ ...base, text: "a https://t.co/a1", links: ["https://x.com/u/status/1"] }).linkMap).toEqual([]); // X・短縮は外部リンクではない
  });
  it("linkMap がある投稿はそれを優先（x_api_entity）。復元は使わない", () => {
    const d = deriveLinkMap({ ...base, text: "a https://t.co/a1", links: ["https://shop.example/other"], linkMap: [{ short: "https://t.co/a1", url: "https://shop.example/a" }] });
    expect(d.methods.get("https://t.co/a1")).toBe("x_api_entity");
    expect(d.linkMap[0].url).toBe("https://shop.example/a");
  });
  it("復元できない項目は『未展開・理由つき』『URLなし』として記録が残る（追跡可能）", () => {
    const post: StoredXPost = { postId: "p2", text: TEXT, links: ["https://shop.example/shared"], recordedAt: null }; // 短縮URLは2つ・保存された外部リンクは1つ → 一意に決まらない
    const plan = planXPost(post);
    expect(plan.items[0].linkEvidence[0]).toMatchObject({ outcome: "unexpanded", method: "none", expandedUrl: null });
    expect(plan.items[0].linkEvidence[0].reason).toContain("robots");
    expect(plan.items[1].linkEvidence[0]).toMatchObject({ outcome: "unexpanded", method: "none" });
    expect(plan.items.map((i) => i.status)).toEqual(["short_unexpanded", "short_unexpanded"]);
    const noUrl = planXPost({ postId: "p3", text: TEXT.replace(" https://t.co/bbb222", ""), links: [], recordedAt: null });
    expect(noUrl.items[1].linkEvidence[0]).toMatchObject({ outcome: "no_url", shortUrl: null, reason: "項目の本文に応募先のURLが無い" });
    expect(noUrl.items[1].status).toBe("url_missing");
    const items = parseListItems(post.text).items;
    expect(buildLinkEvidence(post, items, new Map(), []).map((e) => e.outcome)).toEqual(["unexpanded", "unexpanded"]);
  });
});

describe("復元した対応（stored_unique_pair）は確定にしない", () => {
  it("ページが項目の店舗を名指ししていない限り、対応の検査は candidate 止まり（X APIのentity由来は confirmed になりうる）", async () => {
    const { makeScoper } = await import("./x-origin");
    const html = '<html><h1 class="heading01">拡張パック 抽選</h1><section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">拡張パック 抽選</h4></section></html>';
    const { parseApplyPage } = await import("./page-structure");
    const page = { text: html.replace(/<[^>]+>/g, " "), structure: parseApplyPage(html) };
    const pair = planXPost({ postId: "p", text: "【店舗A】拡張パック抽選 https://t.co/one111", links: ["https://shop.example/a"], recordedAt: null });
    expect(pair.items[0].linkEvidence[0].method).toBe("stored_unique_pair");
    expect(makeScoper(pair.items[0], pair.items, () => null)("https://shop.example/a", page).verdict).toBe("candidate");
    const entity = planXPost({ postId: "p", text: "【店舗A】拡張パック抽選 https://t.co/one111", links: ["https://shop.example/a"], linkMap: [{ short: "https://t.co/one111", url: "https://shop.example/a" }], recordedAt: null });
    expect(makeScoper(entity.items[0], entity.items, () => null)("https://shop.example/a", page).verdict).toBe("confirmed");
  });
});
