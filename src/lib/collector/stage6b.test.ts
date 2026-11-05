import { describe, expect, it } from "vitest";
import { parseXPosts } from "@/lib/collector/x-posts";
import { judgeXPost, emptyFunnel, funnelLine } from "@/lib/collector/x-relevance";
import { classifyStage } from "@/lib/collector/stage";
import { applyAccountHint, normUsername, usernameFromPostUrl, type XLink } from "@/lib/collector/x-accounts";
import { rebuildQueued, storedPostOf } from "@/lib/collector/queued";
import { deepClean, safeSlice, safeSliceEnd, wellFormed } from "@/lib/text-safe";
import { enrichXPost } from "@/lib/server/collector/x-rich";
import type { ExtractedLottery } from "@/lib/ai/extraction";
import type { AppData } from "@/types/domain";

const NOW = new Date("2026-11-05T05:00:00Z");

describe("Stage 6B: 文字列の安全な切り詰め（97件の一括保存が全滅した原因）", () => {
  const emoji = "📅応募期間";
  it("絵文字（サロゲートペア）の途中で切ると孤立サロゲートになり、DBへ送るJSONが不正になる", () => {
    const cut = ("【ポケカ抽選情報】" + "あ".repeat(70) + "⚡" + emoji).slice(0, 80 + 0); // 単純な slice
    const raw = ("x".repeat(79) + "🎯当選").slice(0, 80);
    expect(raw.charCodeAt(79)).toBeGreaterThanOrEqual(0xd800); // 上位サロゲートだけが残る
    expect(wellFormed(raw)).toBe("x".repeat(79));
    expect(cut.length).toBe(80);
  });
  it("safeSlice／safeSliceEnd は文字の途中で切らない", () => {
    const s = "x".repeat(79) + "🎯当選";
    expect(safeSlice(s, 80)).toBe("x".repeat(79));
    expect(safeSlice(s, 81)).toBe("x".repeat(79) + "🎯");
    expect(safeSliceEnd("🎯" + "y".repeat(5), 6)).toBe("y".repeat(5));
    expect(safeSlice("短い", 80)).toBe("短い");
  });
  it("NUL と孤立サロゲートを取り除く（deepClean は入れ子の文字列にも適用）", () => {
    const bad = "a" + String.fromCharCode(0) + "b" + String.fromCharCode(0xd83d) + "c";
    expect(wellFormed(bad)).toBe("abc");
    expect(deepClean({ a: [bad, { b: bad }], n: 1 })).toEqual({ a: ["abc", { b: "abc" }], n: 1 });
  });
});

describe("Stage 6B: X API 応答の解析（画像・引用元・長文）", () => {
  const json = {
    data: [
      {
        id: "100",
        text: "【ポケカ抽選情報】 駿河屋にて…",
        created_at: "2026-11-05T01:00:00.000Z",
        author_id: "u1",
        attachments: { media_keys: ["m1", "m2", "mv"] },
        entities: { urls: [{ expanded_url: "https://example.invalid/apply" }, { expanded_url: "https://x.com/pokecayoyaku/status/100/photo/1" }] },
      },
      { id: "101", text: "引用で紹介 https://t.co/x", author_id: "u1", note_tweet: { text: "長文の全文です。応募期間 11/8〜11/10" }, referenced_tweets: [{ type: "quoted", id: "200" }], entities: { urls: [{ expanded_url: "https://x.com/shop_official/status/200" }] } },
      { id: "102", text: "引用元が展開されなかった", author_id: "u1", referenced_tweets: [{ type: "quoted", id: "999" }] },
    ],
    includes: {
      media: [
        { media_key: "m1", type: "photo", url: "https://pbs.twimg.com/media/a.jpg" },
        { media_key: "m2", type: "photo", url: "https://pbs.twimg.com/media/b.jpg" },
        { media_key: "mv", type: "video", url: "https://video.twimg.com/x.mp4" },
        { media_key: "mq", type: "photo", url: "https://pbs.twimg.com/media/q.jpg" },
      ],
      users: [
        { id: "u1", username: "pokecayoyaku" },
        { id: "u2", username: "shop_official" },
      ],
      tweets: [{ id: "200", text: "公式: 抽選受付 11/8 10:00〜", author_id: "u2", created_at: "2026-11-04T00:00:00.000Z", attachments: { media_keys: ["mq"] }, entities: { urls: [{ expanded_url: "https://shop.example.invalid/lottery" }] } }],
    },
  };
  const posts = parseXPosts(json, "pokecayoyaku");
  it("画像は photo のみ（動画は対象外）、複数枚を漏れなく取得し、画像自身へのリンクは外部リンクにしない", () => {
    expect(posts[0].images).toEqual(["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"]);
    expect(posts[0].links).toEqual(["https://example.invalid/apply"]);
    expect(posts[0].username).toBe("pokecayoyaku");
  });
  it("長文は note_tweet の全文を使う", () => {
    expect(posts[1].text).toContain("応募期間 11/8〜11/10");
  });
  it("引用元の投稿（本文・画像・投稿者・リンク）を展開する。展開されなかった引用は quoted なし", () => {
    expect(posts[1].quoted).toMatchObject({ id: "200", username: "shop_official", images: ["https://pbs.twimg.com/media/q.jpg"], links: ["https://shop.example.invalid/lottery"] });
    expect(posts[1].quoted?.text).toContain("抽選受付");
    expect(posts[2].quoted).toBeUndefined();
    expect(posts[2].refs).toEqual([{ type: "quoted", id: "999" }]);
  });
});

describe("Stage 6B: AI解析へ回すかの判定（本文のキーワードだけで画像付き投稿を落とさない）", () => {
  const j = (o: Partial<Parameters<typeof judgeXPost>[0]>) => judgeXPost({ text: "", images: [], links: [], createdAt: "2026-11-04T00:00:00Z", ...o }, NOW);
  it("本文に抽選情報がある投稿は解析対象（本文）", () => {
    expect(j({ text: "【ポケカ抽選情報】 駿河屋にて拡張パックの抽選応募受付が開始⚡" })).toEqual({ pass: true, basis: "text" });
  });
  it("本文が短い・絵文字だけで、情報が画像にある投稿は解析対象（画像）", () => {
    expect(j({ text: "⚡🎯 https://t.co/abc", images: ["https://pbs.twimg.com/a.jpg"] })).toEqual({ pass: true, basis: "image" });
    expect(j({ text: "本日の抽選まとめ", images: ["https://pbs.twimg.com/a.jpg"] })).toMatchObject({ pass: true, basis: "image" });
  });
  it("引用元の本文にポケモンカードの抽選があれば解析対象（引用）", () => {
    expect(j({ text: "こちら注目⚡", quoted: { text: "ポケモンカード 拡張パックの抽選販売を実施します", images: [], links: [] } })).toEqual({ pass: true, basis: "quote" });
  });
  it("外部リンクがあり抽選の語がある投稿は解析対象（リンク）", () => {
    expect(j({ text: "抽選の応募はこちら https://t.co/abc", links: ["https://shop.example.invalid/l"] })).toEqual({ pass: true, basis: "link" });
  });
  it("他のTCGが主題・無関係な長文・古い投稿は解析しない（有料AIを無条件に使わない）", () => {
    expect(j({ text: "遊戯王の新弾が発売", images: ["https://pbs.twimg.com/a.jpg"] })).toEqual({ pass: false, skip: "other_tcg" });
    expect(j({ text: "今日は天気が良くて散歩に行きました。公園でたくさんの花を見て、とても気持ちの良い一日でした。夕飯は何にしようか考え中です。", images: ["https://pbs.twimg.com/a.jpg"] })).toEqual({ pass: false, skip: "no_signal" });
    expect(j({ text: "【ポケカ抽選情報】 古い告知", createdAt: "2026-09-01T00:00:00Z" })).toEqual({ pass: false, skip: "stale" });
  });
  it("各段階の件数を1行にまとめる", () => {
    const f = emptyFunnel();
    f.fetched = 97;
    f.passed.image = 5;
    f.skipped.no_signal = 90;
    f.saved = 5;
    expect(funnelLine(f)).toContain("投稿97件");
    expect(funnelLine(f)).toContain("新規保存5件");
  });
});

describe("Stage 6B: 抽選の段階（受付前の予告を除外しない）", () => {
  const f = (date: string | null) => (date ? { precision: "date_only", date } : { precision: "unknown", date: null });
  it("受付中／受付前（詳細確定）／予告（詳細未発表）／一部判明", () => {
    expect(classifyStage({ applyStart: f("2026-11-01"), applyDeadline: f("2026-11-10") }, "2026-11-05")).toBe("open");
    expect(classifyStage({ applyStart: f("2026-11-08"), applyDeadline: f("2026-11-10") }, "2026-11-05")).toBe("upcoming");
    expect(classifyStage({ applyStart: f(null), applyDeadline: f(null) }, "2026-11-05")).toBe("teaser");
    expect(classifyStage({ applyStart: f("2026-11-08"), applyDeadline: f(null) }, "2026-11-05")).toBe("partial");
    expect(classifyStage({ applyDeadline: f("2026-11-10") }, "2026-11-05")).toBe("open");
  });
});

describe("Stage 6B: 公式Xアカウントと店舗・系列（投稿者だけで確定しない）", () => {
  const data = {
    chains: [{ id: "c1", name: "サンプル電機", aliases: [], archived: false }, { id: "c2", name: "別の系列", aliases: [], archived: false }],
    stores: [{ id: "s1", chainId: "c1", name: "三宮店", aliases: [], archived: false }, { id: "s2", chainId: "c1", name: "梅田店", aliases: [], archived: false }],
  } as unknown as AppData;
  const ex = (o: Partial<ExtractedLottery>) => ({ chainName: "", storeName: "", ...o }) as ExtractedLottery;
  const store: XLink = { username: "sample_sannomiya", role: "official_store", chainId: null, storeId: "s1" };
  const chain: XLink = { username: "sample_denki", role: "official_chain", chainId: "c1", storeId: null };

  it("アカウント名の正規化と、投稿URLからの投稿者の取り出し", () => {
    expect(normUsername("@Sample_Denki")).toBe("sample_denki");
    expect(usernameFromPostUrl("https://x.com/Sample_Denki/status/123")).toBe("sample_denki");
    expect(usernameFromPostUrl("https://example.invalid/a")).toBeNull();
  });
  it("店舗の公式アカウント: 告知から読み取れなかった系列・店舗だけを補い、二次情報として明示する", () => {
    const r = applyAccountHint(ex({}), store, data);
    expect(r.extraction).toMatchObject({ chainName: "サンプル電機", storeName: "三宮店" });
    expect(r.used.join()).toContain("@sample_sannomiya");
  });
  it("系列の公式アカウント: 系列だけを補い、店舗は確定しない（複数店舗の抽選があるため）", () => {
    const r = applyAccountHint(ex({}), chain, data);
    expect(r.extraction.chainName).toBe("サンプル電機");
    expect(r.extraction.storeName).toBe("");
  });
  it("告知から読み取れた店舗は上書きしない。対応先と食い違うときは注意を出す", () => {
    const r = applyAccountHint(ex({ chainName: "サンプル電機", storeName: "梅田店" }), store, data);
    expect(r.extraction.storeName).toBe("梅田店");
    expect(r.used).toEqual([]);
    expect(r.warnings.join()).toContain("異なります");
  });
  it("対応づけの無いアカウント（まとめアカウント等）は何も補わない", () => {
    const r = applyAccountHint(ex({}), undefined, data);
    expect(r.extraction.storeName).toBe("");
    expect(r.used).toEqual([]);
  });
});

describe("Stage 6B: 取得済みのX投稿情報を保持して再利用する", () => {
  const snap = { id: "100", username: "pokecayoyaku", createdAt: "2026-11-05T01:00:00Z", text: "本文", images: ["https://pbs.twimg.com/a.jpg"], links: [], fetchedAt: "2026-11-05T02:00:00Z" };
  const base = { kind: "x_oembed" as const, url: "https://x.com/pokecayoyaku/status/100", sourceName: "再解析", reason: "manual_reanalyze" as const, changed: true };
  it("解析後の草稿（xpost）から投稿を復元し、再取得せず x_post として再解析できる", () => {
    const q = rebuildQueued({ xpost: snap }, base);
    expect(q.kind).toBe("x_post");
    expect(q.post).toMatchObject({ id: "100", images: ["https://pbs.twimg.com/a.jpg"], username: "pokecayoyaku" });
  });
  it("取得から30日を過ぎた保存情報は使わず、再取得（x_oembed）に戻す", () => {
    expect(storedPostOf({ xpost: snap }, new Date("2026-12-20T00:00:00Z"))).toBeNull();
    expect(rebuildQueued({ xpost: { ...snap, fetchedAt: "2026-09-01T00:00:00Z" } }, base).kind).toBe("x_oembed");
  });
  it("Web のページは対象外（x_post にしない）", () => {
    expect(rebuildQueued({ xpost: snap }, { ...base, kind: "web_page" }).kind).toBe("web_page");
  });
});

describe("Stage 6B: 画像は『見つかった／取得できた／AIへ渡した』を別々に数える。引用元の本文・画像も使う", () => {
  it("引用元の画像を含め、取得に失敗した画像は取得数に数えない", async () => {
    const png = { mediaType: "image/png" as const, base64: "iVBORw0KGgo=", bytes: 8 };
    const fetchImage = async (u: string) => (u.includes("bad") ? null : png);
    const r = await enrichXPost(
      { text: "紹介", links: [], images: ["https://pbs.twimg.com/ok1.png", "https://pbs.twimg.com/bad.png"], quoted: { username: "shop", text: "公式の抽選 11/8〜", images: ["https://pbs.twimg.com/ok2.png"], links: [] } },
      { fetchImage: fetchImage as never, fetchPage: async () => ({ ok: false, code: "network", message: "x" }) },
    );
    expect(r.stats.found).toBe(3);
    expect(r.stats.fetched).toBe(2);
    expect(r.text).toContain("引用元の投稿（@shop）");
    expect(r.text).toContain("公式の抽選");
    expect(r.quotedUsed).toBe(true);
  });
});
