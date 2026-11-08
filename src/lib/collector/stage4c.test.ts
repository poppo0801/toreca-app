import { describe, expect, it } from "vitest";
import { DEFAULT_CONDITIONS, DEFAULT_PREFECTURES, deadlinePassed, detectApplyChannels, evaluateCandidate, normalizeConditions, type CollectionConditions, type EvalContext } from "@/lib/collector/conditions";
import { judgeRelevance, normalizeUrl, parseListing } from "@/lib/collector/listing";
import { X_COST_PER_POST_JPY, classifyXError, compareId, estimateCostJpy, parseXPosts, remainingPosts } from "@/lib/collector/x-posts";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";

const NOW = new Date("2027-01-15T12:00:00+09:00");
const base = (over: Partial<LotteryInput> = {}): LotteryInput =>
  ({
    chain: { id: "c1", name: "サンプル電機" },
    store: { id: "s1", name: "三宮店", prefecture: "" },
    items: [{ product: { id: "p1", name: "商品A" }, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: EMPTY_FLEX,
    applyDeadline: { precision: "date_time", date: "2027-01-20", time: "23:59" },
    receiveMethod: "store",
    applyMethod: "web",
    requirementTags: [],
    sourceUrls: [],
    conditionsText: "",
    ...over,
  }) as unknown as LotteryInput;
const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({ prefecture: "兵庫県", storeKind: "physical", distanceKm: 5, now: NOW, ...over });
const cond = (over: Partial<CollectionConditions> = {}): CollectionConditions => ({ ...DEFAULT_CONDITIONS, ...over });
const ev = (i: Partial<LotteryInput>, c: Partial<CollectionConditions> = {}, x: Partial<EvalContext> = {}) => evaluateCandidate(base(i), cond(c), ctx(x));

describe("収集条件の初期値", () => {
  it("6都府県・通販を含む・距離制限なし・全商品・現在応募可能のみ", () => {
    expect(DEFAULT_PREFECTURES).toEqual(["兵庫県", "大阪府", "京都府", "東京都", "千葉県", "神奈川県"]);
    expect(DEFAULT_CONDITIONS).toMatchObject({ includeOnline: true, maxDistanceKm: null, productMode: "all", statusMode: "open", applyMethods: [], receiveMethods: [] });
  });
  it("不正な値は既定に戻す", () => {
    expect(normalizeConditions({ productMode: "x", statusMode: "y", maxDistanceKm: -3, applyMethods: ["web", "zzz"], includeOnline: false })).toMatchObject({ productMode: "all", statusMode: "open", maxDistanceKm: null, applyMethods: ["web"], includeOnline: false });
  });
});

describe("受付状況（日時を補完しない）", () => {
  it("受付中は一致。締切を過ぎたら除外。受付前は（追跡しない設定なら）除外、追跡する設定なら破棄せず追跡、「受付前も含む」なら登録対象", () => {
    expect(ev({}).verdict).toBe("match");
    expect(ev({ applyDeadline: { precision: "date_time", date: "2027-01-10", time: "10:00" } }).verdict).toBe("exclude");
    const future = { applyStart: { precision: "date_only" as const, date: "2027-02-01", time: "" } };
    expect(ev(future, { trackUpcoming: false }).verdict).toBe("exclude");
    expect(ev(future).verdict).toBe("upcoming"); // 追跡する設定（既定）: 破棄せず、受付が始まるまで保持する（応募可能としては扱わない）
    expect(ev(future, { statusMode: "open_or_before" }).verdict).toBe("match");
  });
  it("締切が不明なら『受付中』とせず要確認。日付のみの締切は当日中は有効（23:59を補わない）", () => {
    expect(ev({ applyDeadline: EMPTY_FLEX }).verdict).toBe("review");
    expect(deadlinePassed({ precision: "date_only", date: "2027-01-15", time: "" }, NOW)).toBe(false);
    expect(deadlinePassed({ precision: "date_only", date: "2027-01-14", time: "" }, NOW)).toBe(true);
    expect(deadlinePassed(EMPTY_FLEX, NOW)).toBeNull();
  });
});

describe("地域・通販・距離", () => {
  it("対象6都府県の店頭は一致、対象外は除外、都道府県不明は要確認", () => {
    for (const p of DEFAULT_PREFECTURES) expect(ev({}, {}, { prefecture: p }).verdict, p).toBe("match");
    expect(ev({}, {}, { prefecture: "北海道" }).verdict).toBe("exclude");
    expect(ev({ store: { id: "s1", name: "サンプル店", prefecture: "" } }, {}, { prefecture: "" }).verdict).toBe("review");
  });
  it("通販・発送の抽選は全国対象（都道府県を問わない）。『通販を含まない』なら除外。Web応募でも通販にはならない", () => {
    expect(ev({ receiveMethod: "shipping" }, {}, { prefecture: "北海道" }).verdict).toBe("match");
    expect(ev({ receiveMethod: "shipping" }, { includeOnline: false }).verdict).toBe("exclude");
    expect(ev({ receiveMethod: "store", applyMethod: "web" }, {}, { prefecture: "北海道" }).verdict).toBe("exclude");
    expect(ev({}, {}, { storeKind: "online_only", prefecture: "" }).verdict).toBe("match"); // オンライン専用店舗は通販
  });
  it("店頭・発送どちらでも: 地域外でも発送で受け取れるので一致（通販を含む場合）", () => {
    expect(ev({ receiveMethod: "either" }, {}, { prefecture: "北海道" }).verdict).toBe("match");
    expect(ev({ receiveMethod: "either" }, { includeOnline: false }, { prefecture: "北海道" }).verdict).toBe("exclude");
  });
  it("受取方法が不明: 地域が対象なら「未確認」の注記つきで一致、地域も不明（または対象外）なら要確認（推測しない）", () => {
    const r = ev({ receiveMethod: "unknown" });
    expect(r.verdict).toBe("match");
    expect(r.reasons.join("")).toContain("受取方法は未確認");
    expect(ev({ receiveMethod: "unknown", store: { id: "s1", name: "サンプル店", prefecture: "" } }, {}, { prefecture: "" }).verdict).toBe("review");
    // 特定の1店舗の抽選で地域が対象外と分かれば、受取方法が不明でも除外する（Stage 7A）。店舗が特定できない（店舗名なし）ときは要確認のまま
    expect(ev({ receiveMethod: "unknown" }, {}, { prefecture: "北海道" }).verdict).toBe("exclude");
    expect(ev({ receiveMethod: "unknown", store: { id: null, name: "", prefecture: "" } }, {}, { prefecture: "北海道" }).verdict).toBe("review");
    expect(ev({ receiveMethod: "unknown" }, { maxDistanceKm: 10 }, { distanceKm: 50 }).verdict).toBe("exclude");
  });
  it("距離制限: 超えたら除外、位置不明は要確認（0kmにしない）、通販には適用しない", () => {
    expect(ev({}, { maxDistanceKm: 10 }, { distanceKm: 5 }).verdict).toBe("match");
    expect(ev({}, { maxDistanceKm: 10 }, { distanceKm: 50 }).verdict).toBe("exclude");
    expect(ev({}, { maxDistanceKm: 10 }, { distanceKm: null }).verdict).toBe("review");
    expect(ev({ receiveMethod: "shipping" }, { maxDistanceKm: 1 }, { distanceKm: null }).verdict).toBe("match");
  });
  it("受取方法の絞り込み", () => {
    expect(ev({ receiveMethod: "store" }, { receiveMethods: ["shipping"] }).verdict).toBe("exclude");
    expect(ev({ receiveMethod: "shipping" }, { receiveMethods: ["shipping"] }).verdict).toBe("match");
  });
});

describe("応募方法・応募条件・商品", () => {
  it("応募方法のチャネルを判定し、絞り込める（LivePocket・X・LINE）", () => {
    expect(detectApplyChannels({ applyMethod: "web", requirementTags: ["line_register"], sourceUrls: ["https://t.livepocket.jp/e/x"] }).sort()).toEqual(["line", "livepocket", "web"]);
    expect(ev({ applyMethod: "app" }, { applyMethods: ["web"] }).verdict).toBe("exclude");
    expect(ev({ applyMethod: "unknown" }, { applyMethods: ["web"] }).verdict).toBe("review");
  });
  it("応募条件: 含む／除外。一般的な本人確認は対象にしない。居住地域の制限は要確認", () => {
    expect(ev({ requirementTags: ["member_card"] }, { reqExclude: ["member_card"] }).verdict).toBe("exclude");
    expect(ev({ requirementTags: ["purchase_history"] }, { reqInclude: ["member_card"] }).verdict).toBe("exclude");
    expect(ev({ requirementTags: [] }, { reqInclude: ["member_card"] }).verdict).toBe("review");
    expect(ev({ requirementTags: ["id_check", "photo_id"] }, { reqExclude: ["id_check", "photo_id"] }).verdict).toBe("match");
    expect(ev({ requirementTags: ["resident_area"] }).verdict).toBe("review");
  });
  it("商品: 全商品は未登録の新商品も除外しない。指定・除外の設定", () => {
    const unknownProduct = { items: [{ product: { id: null, name: "新弾" }, quantity: 1, unit: "box" as const }] };
    expect(ev(unknownProduct).verdict).toBe("match");
    expect(ev({}, { productMode: "include", productIds: ["p9"] }).verdict).toBe("exclude");
    expect(ev(unknownProduct, { productMode: "include", productIds: ["p9"] }).verdict).toBe("review");
    expect(ev({}, { productMode: "exclude", productIds: ["p1"] }).verdict).toBe("exclude");
  });
});

describe("Webサイトの一覧の解析", () => {
  const html = `
    <a href="/chusen/x">サイト内</a>
    <a href="https://hb.afl.rakuten.co.jp/hgc/abc">広告</a>
    <div><a href="https://x.com/shop_a/status/1234567890123?utm_source=a">ポケモンカード 抽選</a></div>
    <div><a href="https://twitter.com/shop_b/status/1234567890124">ポケカ</a></div>
    <a href="https://x.com/shop_a">プロフィール</a>
    <a href="https://shop.example.invalid/lottery?id=1&amp;utm_campaign=z#top">店舗の抽選</a>
    <a href="https://shop.example.invalid/lottery?id=1">同じリンク</a>
    <a href="https://shop.example.invalid/banner.png">画像</a>
    <a href="mailto:a@b.c">m</a>`;
  it("外部の告知リンクだけを取り出す（サイト内・広告・画像・プロフィールは除く）。同じ宛先は1件にまとめ、twitter.comはx.comに正規化する", () => {
    const e = parseListing("pokeso", html, "https://pokeso.jp/chusen");
    expect(e.map((x) => x.url)).toEqual(["https://x.com/shop_a/status/1234567890123", "https://x.com/shop_b/status/1234567890124", "https://shop.example.invalid/lottery?id=1"]);
    expect(e.map((x) => x.kind)).toEqual(["x_post", "x_post", "page"]);
  });
  it("構造が変わって告知リンクが無ければ0件（取得できたことにしない）", () => {
    expect(parseListing("torecabiyori", "<p>メンテナンス中</p>", "https://torecabiyori.com/chusen/pokemon/")).toEqual([]);
  });
  it("隣のリンクの文章を、周辺の文脈に混ぜない", () => {
    const e = parseListing("generic", `<a href="https://a.example.invalid/1">ポケモンカード 抽選</a><a href="https://b.example.invalid/2">遊戯王 抽選</a>`, "https://list.example.invalid/");
    expect(judgeRelevance(`${e[0].title} ${e[0].context}`, { fromPokemonList: true }).relevant).toBe(true);
    expect(judgeRelevance(`${e[1].title} ${e[1].context}`, { fromPokemonList: true }).relevant).toBe(false);
  });
  it("URLの正規化", () => {
    expect(normalizeUrl("http://www.twitter.com/a/status/12345?s=20&t=x")).toBe("https://x.com/a/status/12345");
    expect(normalizeUrl("https://user:pw@example.com/")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("ポケモンカードの関連判定（ルールベース）", () => {
  it("ポケモンカードの抽選は関連あり。他のTCGは除外。手掛かりが無ければ不確実（一覧由来はAIに任せる）", () => {
    expect(judgeRelevance("ポケモンカード 拡張パック 抽選販売のお知らせ")).toMatchObject({ relevant: true, uncertain: false });
    expect(judgeRelevance("遊戯王OCG 抽選販売")).toMatchObject({ relevant: false });
    expect(judgeRelevance("ワンピースカード 新弾 予約抽選")).toMatchObject({ relevant: false });
    expect(judgeRelevance("新弾 抽選受付中", { fromPokemonList: true })).toMatchObject({ relevant: true, uncertain: true });
    expect(judgeRelevance("今日のランチ")).toMatchObject({ relevant: false });
  });
});

describe("X公式APIの応答の解析と費用管理", () => {
  const json = {
    data: [
      { id: "1002", text: "抽選のお知らせ https://t.co/x", created_at: "2027-01-10T00:00:00.000Z", author_id: "9", entities: { urls: [{ expanded_url: "https://shop.example.invalid/lottery", url: "https://t.co/x" }, { expanded_url: "https://x.com/s/status/1002/photo/1" }] }, attachments: { media_keys: ["m1", "m2", "m3"] }, referenced_tweets: [{ type: "quoted", id: "1001" }] },
      { id: "bad id", text: "x" },
    ],
    includes: { media: [{ media_key: "m1", type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }, { media_key: "m2", type: "photo", url: "https://pbs.twimg.com/media/b.jpg" }, { media_key: "m3", type: "video", url: "https://evil.example/c.jpg" }] },
  };
  it("投稿ID・本文・日時・投稿者・URL・画像（複数全件、動画は除く）・外部リンク・引用を取り出す", () => {
    const p = parseXPosts(json, "pokecachan");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: "1002", authorId: "9", url: "https://x.com/pokecachan/status/1002", images: ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"], links: ["https://shop.example.invalid/lottery"], refs: [{ type: "quoted", id: "1001" }] });
  });
  it("不正な応答は空", () => {
    expect(parseXPosts(null, "a")).toEqual([]);
    expect(parseXPosts({ data: "x" }, "a")).toEqual([]);
  });
  it("エラー（認証・残高不足・レート制限）を原因つきで表示できる", () => {
    expect(classifyXError(401, {}).code).toBe("unauthorized");
    expect(classifyXError(402, {}).code).toBe("credits_depleted");
    expect(classifyXError(429, {}).code).toBe("rate_limited");
    expect(classifyXError(403, { detail: "Forbidden" }).message).toContain("Forbidden");
  });
  it("月額予算: 0円・上限到達で取得できない。見積もりは切り上げ", () => {
    expect(remainingPosts({ monthPosts: 0, budgetJpy: 0 })).toBe(0);
    expect(remainingPosts({ monthPosts: 0, budgetJpy: 1200 })).toBe(Math.floor(1200 / X_COST_PER_POST_JPY));
    expect(remainingPosts({ monthPosts: 1000, budgetJpy: 1200 })).toBe(0);
    expect(estimateCostJpy(10)).toBe(Math.ceil(10 * X_COST_PER_POST_JPY));
    expect(compareId("99", "100")).toBeLessThan(0);
  });
});

import { parseListHints } from "@/lib/collector/listing";
import { preScreenFromList } from "@/lib/collector/conditions";

describe("一覧の表示だけでの事前判定（AI読み取りの前・費用なし）", () => {
  const NOW2 = new Date("2026-11-02T12:00:00+09:00");
  it("実サイトの表示形式から、締切・都道府県・通販を読み取る（pokeso・トレカ日和）", () => {
    expect(parseListHints("¥5,500 11/3(火) 20:30まで 千葉県・LivePocket 応募する", NOW2)).toEqual({ deadlineIso: "2026-11-03T11:30:00.000Z", deadlineDate: null, prefecture: "千葉県", online: false });
    const t = parseListHints("以内に締切 11/1(日) 22:00 まで 10/30(金) 10:00 から 応募する （古本市場 南茨木店・新しいタブで開きます）", NOW2);
    expect(t.deadlineIso).toBe("2026-11-01T13:00:00.000Z");
    expect(t.prefecture).toBe("");
    expect(parseListHints("締切 11/5(木) 23:59 10/30(金) 10:00 受付開始 応募ページへ", NOW2).deadlineIso).toBe("2026-11-05T14:59:00.000Z");
    expect(parseListHints("通販・LivePocket 応募する", NOW2).online).toBe(true);
  });
  it("時刻の表示が無い締切（11/6(金)まで）は日付だけで判定し、当日中は除外しない。『から』（開始）は締切にしない", () => {
    expect(parseListHints("¥10,800 11/6(金)まで 石川県・応募", NOW2)).toMatchObject({ deadlineIso: null, deadlineDate: "2026-11-06" });
    expect(parseListHints("11/2(月) 09:30から 東京都・申込", NOW2)).toMatchObject({ deadlineIso: null, deadlineDate: null });
    expect(preScreenFromList(parseListHints("11/2(月)まで 東京都・申込", NOW2), DEFAULT_CONDITIONS, NOW2)).toBeNull(); // 当日中
    expect(preScreenFromList(parseListHints("11/1(日)まで 東京都・申込", NOW2), DEFAULT_CONDITIONS, NOW2)).toContain("締切");
  });
  it("読み取れない項目は推測しない（締切なし・地域なし）", () => {
    expect(parseListHints("応募する", NOW2)).toEqual({ deadlineIso: null, deadlineDate: null, prefecture: "", online: false });
  });
  it("年をまたぐ表示（12月に見る1月の締切）は翌年にする", () => {
    expect(parseListHints("1/5(火) 20:00まで", new Date("2026-12-28T12:00:00+09:00")).deadlineIso).toBe("2027-01-05T11:00:00.000Z");
  });
  it("締切済み・対象外の地域は解析前に除外。通販表示・不明・受付中は除外しない", () => {
    const c = DEFAULT_CONDITIONS;
    const ended = parseListHints("11/1(日) 22:00 まで", NOW2);
    expect(preScreenFromList(ended, c, NOW2)).toContain("締切");
    expect(preScreenFromList(parseListHints("11/3(火) 20:30まで 愛知県・LivePocket", NOW2), c, NOW2)).toContain("愛知県");
    expect(preScreenFromList(parseListHints("11/3(火) 20:30まで 千葉県・LivePocket", NOW2), c, NOW2)).toBeNull();
    expect(preScreenFromList(parseListHints("11/3(火) 20:30まで 愛知県・通販・LivePocket", NOW2), c, NOW2)).toBeNull();
    expect(preScreenFromList(parseListHints("応募する", NOW2), c, NOW2)).toBeNull();
    // 対象の都道府県を変えれば判定も変わる
    expect(preScreenFromList(parseListHints("11/3(火) 20:30まで 愛知県・LivePocket", NOW2), { ...c, prefectures: ["愛知県"] }, NOW2)).toBeNull();
  });
});
