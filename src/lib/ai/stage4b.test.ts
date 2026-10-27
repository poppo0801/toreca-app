// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { hasAnyContent, normalizeExtraction } from "@/lib/ai/extraction";
import { decodeEntities, extractPageText, pageToPrompt } from "@/lib/ai/page-text";
import { getExtractor } from "@/lib/ai/provider";
import { buildDraft, dice, findDuplicates, matchChain, matchProduct, matchStore } from "@/lib/lottery-match";
import { lotteryInputSchema } from "@/lib/lottery-input";

// 2026-10-28 12:00 JST
const NOW = new Date("2026-10-28T03:00:00Z");
const d = (month: number, day: number, hour: number | null = null, minute: number | null = null, year: number | null = null) => ({ year, month, day, hour, minute });

const base = {
  is_lottery_announcement: true,
  chain_name: "サンプル電機",
  store_name: "三宮店",
  products: [{ name: "テスト拡張パック「ひかりの森」", code: "", quantity: 1, unit: "box" }],
  multi_mode: "single",
  apply_deadline: d(11, 5, 23, 59),
};

describe("normalizeExtraction（AI出力の検証・正規化）", () => {
  it("年の記載がない日付は今日に近い年を補い、注意を出す。時刻があれば日時、無ければ日付のみ", () => {
    const e = normalizeExtraction({ ...base, apply_start: d(11, 1), result_date: d(1, 10) }, NOW);
    expect(e.applyDeadline).toMatchObject({ precision: "date_time", date: "2026-11-05", time: "23:59", yearAssumed: true });
    expect(e.applyStart).toMatchObject({ precision: "date_only", date: "2026-11-01" });
    // 1/10 は今日(10/28)より2か月以上前 → 翌年の告知と仮定
    expect(e.resultDate.date).toBe("2027-01-10");
    expect(e.warnings.some((w) => w.includes("年の記載がない"))).toBe(true);
  });

  it("年が書かれていればそのまま使い、現在から離れた年・存在しない日付は不明にする", () => {
    const e = normalizeExtraction({ ...base, apply_deadline: d(12, 1, 10, 0, 2026), result_date: d(2, 30, null, null, 2027), apply_start: d(1, 1, null, null, 2019) }, NOW);
    expect(e.applyDeadline).toMatchObject({ date: "2026-12-01", time: "10:00", yearAssumed: false });
    expect(e.resultDate.precision).toBe("unknown");
    expect(e.applyStart.precision).toBe("unknown");
  });

  it("不正・欠落した出力でも例外にならず、不明のまま残る（推測で埋めない）", () => {
    const e = normalizeExtraction({ chain_name: 5, products: "x", apply_deadline: { month: "あ" } }, NOW);
    expect(e.chainName).toBe("");
    expect(e.items).toEqual([]);
    expect(e.applyDeadline.precision).toBe("unknown");
    expect(hasAnyContent(e)).toBe(false);
    expect(normalizeExtraction(null, NOW).isLotteryAnnouncement).toBe(true);
  });

  it("単位が無い商品はBOXとして注意を出す。商品が複数でも方式が不明なら unknown のまま", () => {
    const e = normalizeExtraction(
      { ...base, products: [{ name: "A", quantity: 1, unit: null }, { name: "B", quantity: 2, unit: "pack" }], multi_mode: "unknown" },
      NOW,
    );
    expect(e.items[0]).toMatchObject({ unit: "box", unitAssumed: true });
    expect(e.items[1]).toMatchObject({ unit: "pack", unitAssumed: false });
    expect(e.multiMode).toBe("unknown");
    expect(e.warnings.some((w) => w.includes("単位"))).toBe(true);
  });

  it("http(s)以外のURLは捨てる", () => {
    const e = normalizeExtraction({ ...base, apply_url: "javascript:alert(1)", announcement_url: "https://example.invalid/a" }, NOW);
    expect(e.applyUrl).toBe("");
    expect(e.announcementUrl).toBe("https://example.invalid/a");
  });
});

describe("商品・店舗・系列の照合", () => {
  const data = createMockData(NOW);

  it("正式名称・略称・コード・表記ゆれ（全半角・空白）で照合し、無関係な名称は一致させない", () => {
    expect(matchProduct("テスト拡張パック「ひかりの森」", "", data.products)).toMatchObject({ kind: "exact", item: { id: "p1" } });
    expect(matchProduct("ほしぞら", "", data.products)).toMatchObject({ kind: "alias", item: { id: "p2" } });
    expect(matchProduct("なにか", "T3", data.products)).toMatchObject({ kind: "code", item: { id: "p3" } });
    expect(matchProduct("テスト 拡張パック 「ひかりの森」", "", data.products).item?.id).toBe("p1");
    expect(matchProduct("まったく別の商品ABC", "", data.products).kind).toBe("none");
    expect(matchChain("ｻﾝﾌﾟﾙ電機", data.chains).item?.id).toBe("c1");
    expect(matchChain("未知の系列XYZ", data.chains).item).toBeNull();
  });

  it("店舗は選択済みの系列の中だけで照合し、系列名つきの表記も扱う", () => {
    expect(matchStore("三宮店", "c1", data.stores, "サンプル電機").item?.id).toBe("s1");
    expect(matchStore("サンプル電機 三宮店", "c1", data.stores, "サンプル電機").item?.id).toBe("s1");
    expect(matchStore("梅田店", "c1", data.stores, "サンプル電機").item).toBeNull(); // 別系列の店舗
    expect(matchStore("三宮店", null, data.stores).item).toBeNull();
  });

  it("Dice係数は同一で1、無関係で低い", () => {
    expect(dice("ひかりの森", "ひかりの森")).toBe(1);
    expect(dice("ひかりの森", "ほしぞら")).toBeLessThan(0.3);
  });
});

describe("buildDraft（登録フォームの下書き）", () => {
  const data = createMockData(NOW);
  const ex = (o: object) => normalizeExtraction({ ...base, ...o }, NOW);

  it("既存マスターは選択済みにし、下書きは登録フォームの検証を通る", () => {
    const draft = buildDraft(ex({ apply_url: "https://example.invalid/apply" }), data, { sourceUrl: "https://example.invalid/notice" });
    expect(draft.input.chain.id).toBe("c1");
    expect(draft.input.store.id).toBe("s1");
    expect(draft.input.items[0].product.id).toBe("p1");
    expect(draft.input.sourceUrls).toEqual(["https://example.invalid/notice", "https://example.invalid/apply"]);
    expect(draft.input.memo).toContain("応募URL");
  });

  it("未登録の系列・店舗・商品は名称のまま（保存時に仮マスター）、フォームの検証も通る", () => {
    const draft = buildDraft(ex({ chain_name: "新規チェーン", store_name: "新店", products: [{ name: "新商品X", quantity: 2, unit: "pack" }] }), data);
    expect(draft.input.chain).toEqual({ id: null, name: "新規チェーン" });
    expect(draft.input.items[0]).toMatchObject({ product: { id: null, name: "新商品X" }, quantity: 2, unit: "pack" });
    expect(draft.flags.chain).toContain("仮登録");
    expect(lotteryInputSchema.safeParse(draft.input).error?.issues).toBeUndefined();
  });

  it("複数商品で方式が不明なら確定せず modePending。方式が読めればそのまま使う", () => {
    const two = { products: [{ name: "テスト拡張パック「ひかりの森」", quantity: 1, unit: "box" }, { name: "サンプル拡張パック「ほしぞら」", quantity: 1, unit: "box" }] };
    const pending = buildDraft(ex({ ...two, multi_mode: "unknown" }), data);
    expect(pending.modePending).toBe(true);
    expect(pending.flags.multiMode).toBeTruthy();
    const known = buildDraft(ex({ ...two, multi_mode: "one_win" }), data);
    expect(known.modePending).toBe(false);
    expect(known.input.multiMode).toBe("one_win");
    expect(known.input.items.map((i) => i.product.id)).toEqual(["p1", "p2"]);
  });

  it("同じ商品を2行に割り当てない。年を補った日時と空の項目に注意を付ける", () => {
    const dup = buildDraft(ex({ products: [{ name: "ひかりの森", quantity: 1, unit: "box" }, { name: "テスト拡張パック「ひかりの森」", quantity: 1, unit: "box" }], multi_mode: "all" }), data);
    expect(dup.input.items.filter((i) => i.product.id === "p1")).toHaveLength(1);
    const draft = buildDraft(ex({ result_date: null }), data);
    expect(draft.flags.applyDeadline).toContain("年");
    expect(draft.flags.limit).toBeTruthy();
  });
});

describe("重複検出", () => {
  const data = createMockData(NOW);
  // モックの L1: サンプル電機 三宮店 / ひかりの森 / 締切は約5時間後
  const l1 = data.lotteries.find((l) => l.id === "L1")!;
  const input = (deadline: { precision: "unknown" | "date_only"; date: string }) => {
    const draft = buildDraft(normalizeExtraction(base, NOW), data);
    return { ...draft.input, applyDeadline: { ...deadline, time: "" } };
  };

  it("同じ店舗・同じ商品・同じ締切日は high、締切が不明なら medium、別の日・別の店舗は対象外", () => {
    const day = new Date(NOW.getTime() + 5 * 3600_000 + 9 * 3600_000).toISOString().slice(0, 10);
    expect(findDuplicates(input({ precision: "date_only", date: day }), [l1])[0]).toMatchObject({ lotteryId: "L1", level: "high" });
    expect(findDuplicates(input({ precision: "unknown", date: "" }), [l1])[0]?.level).toBe("medium");
    expect(findDuplicates(input({ precision: "date_only", date: "2031-01-01" }), [l1])).toEqual([]);
    const other = { ...input({ precision: "unknown", date: "" }), store: { id: "s2", name: "名谷店", prefecture: "" } };
    expect(findDuplicates(other, [l1])).toEqual([]);
  });

  it("同じ情報源URLなら締切が違っても high", () => {
    const inp = { ...input({ precision: "date_only", date: "2031-01-01" }), sourceUrls: ["https://example.invalid/sample/l1-notice"] };
    expect(findDuplicates(inp, [l1])[0].level).toBe("high");
  });

  it("未登録の系列・店舗・商品では判定しない", () => {
    const draft = buildDraft(normalizeExtraction({ ...base, chain_name: "新規", store_name: "新店" }, NOW), data);
    expect(draft.duplicates).toEqual([]);
  });
});

describe("ページ本文の抽出", () => {
  it("script/style/コメントを除去し、見出しと改行を残し、エンティティを復号する", () => {
    const html = `<html><head><title>抽選販売のお知らせ &amp; 応募</title><meta property="og:description" content="説明文"></head>
      <body><script>alert(1)</script><style>.a{}</style><!-- hidden -->
      <h1>抽選販売</h1><p>応募期間：11月1日〜11月5日&nbsp;23:59</p><ul><li>お一人様1BOX</li></ul>
      <a href="/apply">応募はこちら</a><a href="javascript:void(0)">x</a></body></html>`;
    const p = extractPageText(html, "https://shop.example.invalid/news/1");
    expect(p.title).toBe("抽選販売のお知らせ & 応募");
    expect(p.description).toBe("説明文");
    expect(p.text).toContain("抽選販売");
    expect(p.text).toContain("応募期間：11月1日〜11月5日 23:59");
    expect(p.text).not.toContain("alert");
    expect(p.text).not.toContain("hidden");
    expect(p.links).toEqual([{ text: "応募はこちら", href: "https://shop.example.invalid/apply" }]);
    expect(pageToPrompt(p)).toContain("応募はこちら → https://shop.example.invalid/apply");
    expect(decodeEntities("&#x30A2;&#12354;&unknown;")).toBe("アあ&unknown;");
  });
});

describe("AIエンジンの選択（モックと本物を取り違えない）", () => {
  it("未設定は null、mock 指定はモック、APIキーがあれば Claude", () => {
    expect(getExtractor({})).toBeNull();
    expect(getExtractor({ ANTHROPIC_API_KEY: "  " })).toBeNull();
    expect(getExtractor({ AI_PROVIDER: "mock" })?.engine).toBe("mock");
    expect(getExtractor({ ANTHROPIC_API_KEY: "sk-ant-dummy-not-real" })?.engine).toBe("anthropic");
  });

  it("モックの出力は固定のサンプルで、本文に応じて複数商品になる", async () => {
    const mock = getExtractor({ AI_PROVIDER: "mock" })!;
    const one = normalizeExtraction((await mock.extract({ kind: "text", text: "単一の告知", now: NOW })).raw, NOW);
    const two = normalizeExtraction((await mock.extract({ kind: "text", text: "複数商品の告知", now: NOW })).raw, NOW);
    expect(one.items).toHaveLength(1);
    expect(two.items).toHaveLength(2);
    expect(two.multiMode).toBe("unknown");
  });
});
