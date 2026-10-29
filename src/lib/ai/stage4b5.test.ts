// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { normalizeExtraction, resolveYear, type ExtractedLottery } from "@/lib/ai/extraction";
import { aiSnapshot, compareFeedback, inputSnapshot } from "@/lib/ai/feedback";
import { quoteInSource, validateExtraction } from "@/lib/ai/validate";
import { findPublishedOn } from "@/lib/ai/page-text";
import { buildDraft, cleanProductName, matchChain, matchProduct, matchStore } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";
import { parseOembedDate } from "@/lib/server/x-source";
import type { AppData } from "@/types/domain";

const NOW = new Date("2026-10-28T03:00:00Z"); // 2026-10-28 12:00 JST
const d = (m: number, day: number, hour: number | null = null, minute: number | null = null, year: number | null = null) => ({ year, month: m, day, hour, minute });
const base = {
  is_lottery_announcement: true,
  chain_name: "サンプル電機",
  store_name: "三宮店",
  products: [{ name: "拡張パック「ひかりの森」", code: "", quantity: 1, unit: "box" }],
  multi_mode: "single",
};

// ---------------------------------------------------------------- 年の推定
describe("年の補完（基準日・前後関係・年またぎ）。時刻の補完とは別", () => {
  const ctx = (refDate: string, hasPosted = false) => ({ refDate, hasPosted });

  it("年が書かれていれば、その年を優先する", () => {
    expect(resolveYear({ year: 2027, month: 1, day: 10 }, ctx("2026-10-28"), null)).toEqual({ year: 2027, assumed: false, uncertain: false });
  });

  it("2026年10月の告知の1月の抽選は2027年（年またぎ）。自然な推定なので注意は出さない", () => {
    const r = resolveYear({ year: null, month: 1, day: 10 }, ctx("2026-10-28"), null);
    expect(r).toEqual({ year: 2027, assumed: true, uncertain: false });
  });

  it("基準日（告知の公開日）が優先される: 2026年11月の投稿の「1月」は2027年、2026年1月の投稿の「1月」は2026年", () => {
    expect(resolveYear({ year: null, month: 1, day: 20 }, ctx("2026-11-20", true), null).year).toBe(2027);
    expect(resolveYear({ year: null, month: 1, day: 20 }, ctx("2026-01-05", true), null).year).toBe(2026);
  });

  it("日付の前後関係: 締切12/20 → 発表1/10 は翌年。発表が先に来る年は選ばない", () => {
    const e = normalizeExtraction({ ...base, apply_deadline: d(12, 20, 23, 59), result_date: d(1, 10), procedure_deadline: d(1, 31) }, NOW);
    expect(e.applyDeadline.date).toBe("2026-12-20");
    expect(e.resultDate.date).toBe("2027-01-10");
    expect(e.procedureDeadline.date).toBe("2027-01-31");
    expect(e.warnings.filter((w) => w.includes("年"))).toEqual([]); // どれも自然な推定
  });

  it("過去の告知（公開日が分かる）を無条件に未来へ動かさない。公開日が不明な過去の日付は、年が不確かとして要確認", () => {
    // 公開日 2026-03-01 の告知の「3月10日」は2026年（今日が10月でも、翌年にしない）
    const past = normalizeExtraction({ ...base, apply_deadline: d(3, 10, 12, 0) }, NOW, { postedOn: "2026-03-01" });
    expect(past.applyDeadline).toMatchObject({ date: "2026-03-10", yearAssumed: true, yearUncertain: false });
    expect(past.postedOn).toBe("2026-03-01");
    // 公開日が不明で、今日(10/28)から約4か月前の日付は、2026年と推定するが不確か → 要確認の注意
    const unknown = normalizeExtraction({ ...base, apply_deadline: d(6, 10, 12, 0) }, NOW);
    expect(unknown.applyDeadline).toMatchObject({ date: "2026-06-10", yearUncertain: true });
    expect(unknown.warnings.some((w) => w.includes("確認してください"))).toBe(true);
  });

  it("AIが読み取った公開日（年つき）も基準にする。年が無い公開日は使わない", () => {
    const e = normalizeExtraction({ ...base, apply_deadline: d(1, 15, 12, 0), published_on: d(11, 20, null, null, 2026) }, NOW);
    expect(e.postedOn).toBe("2026-11-20");
    expect(e.applyDeadline.date).toBe("2027-01-15");
    expect(normalizeExtraction({ ...base, published_on: d(11, 20) }, NOW).postedOn).toBe("");
  });

  it("時刻は年と別: 年を補っても、原文に時刻が無ければ日付のみのまま（23:59などを補わない）", () => {
    const e = normalizeExtraction({ ...base, result_date: d(11, 13) }, NOW);
    expect(e.resultDate).toMatchObject({ precision: "date_only", date: "2026-11-13", time: "" });
  });
});

describe("公開日の取得（ページ・X投稿）", () => {
  it("ページのメタ情報・JSON-LD・timeタグから公開日を取る。無ければ空", () => {
    expect(findPublishedOn('<meta property="article:published_time" content="2026-07-16T19:00:00+09:00">')).toBe("2026-07-16");
    expect(findPublishedOn('<script type="application/ld+json">{"datePublished":"2026-09-07T00:00:00Z"}</script>')).toBe("2026-09-07");
    expect(findPublishedOn('<time datetime="2026-10-01">10月1日</time>')).toBe("2026-10-01");
    expect(findPublishedOn("<html><body>日付なし</body></html>")).toBe("");
  });

  it("X投稿の日付（日本語・英語表記）", () => {
    expect(parseOembedDate('<blockquote><p>本文</p>&mdash; 店 (@x) <a href="u">2026年10月5日</a></blockquote>')).toBe("2026-10-05");
    expect(parseOembedDate('<blockquote><p>text</p>&mdash; jack (@jack) <a href="u">March 21, 2006</a></blockquote>')).toBe("2006-03-21");
    expect(parseOembedDate("<blockquote><p>日付なし</p></blockquote>")).toBe("");
  });
});

// ---------------------------------------------------------------- 検証
const withEvidence = (over: Record<string, unknown>, evidence: Record<string, string>) => normalizeExtraction({ ...base, ...over, evidence }, NOW);

describe("解析結果の妥当性検証（矛盾は創作せず要確認に）", () => {
  const SOURCE = "サンプル電機 三宮店 拡張パック「ひかりの森」1BOX 応募期間 11月5日10:00〜11月10日23:59 当選発表 11月13日 応募はこちら https://example.invalid/apply お一人様1点まで";

  it("根拠の抜粋が原文にあるか照合する（全角半角・空白の違いは無視）。原文に無い抜粋は要確認", () => {
    expect(quoteInSource("応募期間 11月5日１０:００", SOURCE)).toBe(true);
    expect(quoteInSource("11月5日…23:59", SOURCE)).toBe(true);
    expect(quoteInSource("12月31日締切", SOURCE)).toBe(false);
    const ex = validateExtraction(withEvidence({ apply_deadline: d(11, 10, 23, 59) }, { apply_deadline: "11月10日23:59", chain: "存在しない文言ABC" }), SOURCE);
    expect(ex.evidence.applyDeadline?.verified).toBe(true);
    expect(ex.evidence.chain?.verified).toBe(false);
    expect(ex.confidence.chain).toBe("low");
    expect(ex.issues.some((i) => i.field === "chain")).toBe(true);
    // 画像など原文が無い入力は照合しない（null）
    expect(validateExtraction(withEvidence({}, { chain: "サンプル電機" }), null).evidence.chain?.verified).toBeNull();
  });

  it("原文（根拠）に時刻が無いのに時刻が付いていたら、日付のみに戻す（時刻を補わない）", () => {
    const ex = validateExtraction(withEvidence({ result_date: d(11, 13, 12, 0) }, { result_date: "当選発表 11月13日" }), SOURCE);
    expect(ex.resultDate).toMatchObject({ precision: "date_only", date: "2026-11-13", time: "" });
    expect(ex.issues.some((i) => i.field === "resultDate" && i.message.includes("日付のみ"))).toBe(true);
    // 時刻が根拠に含まれていれば、そのまま
    const keep = validateExtraction(withEvidence({ apply_deadline: d(11, 10, 23, 59) }, { apply_deadline: "11月10日23:59" }), SOURCE);
    expect(keep.applyDeadline).toMatchObject({ precision: "date_time", time: "23:59" });
  });

  it("日付の前後関係が矛盾していたら、値は直さず要確認にする", () => {
    const ex = validateExtraction(normalizeExtraction({ ...base, apply_start: d(11, 12, 10, 0), apply_deadline: d(11, 10, 23, 59), result_date: d(11, 8) }, NOW), null);
    expect(ex.confidence.applyStart).toBe("low");
    expect(ex.confidence.applyDeadline).toBe("low");
    expect(ex.confidence.resultDate).toBe("low");
    expect(ex.applyStart.date).toBe("2026-11-12"); // 値は変えない
    expect(ex.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("商品名に数量が混入、複数商品なのに単一、購入数量(お一人様1点まで)を応募制限と取り違え、を検出する", () => {
    const ex = validateExtraction(
      normalizeExtraction(
        {
          ...base,
          products: [{ name: "拡張パック「ひかりの森」 1BOX（30パック入り）", code: "", quantity: 1, unit: "box" }, { name: "別の商品", code: "", quantity: 1, unit: "box" }],
          multi_mode: "single",
          limit_basis: "person",
          limit_max_count: 1,
          purchase_limit_text: "お一人様1点まで",
        },
        NOW,
      ),
      null,
    );
    expect(ex.issues.some((i) => i.field === "items" && i.message.includes("数量"))).toBe(true);
    expect(ex.confidence.items).toBe("low");
    expect(ex.multiMode).toBe("unknown");
    expect(ex.limitBasis).toBe("unknown");
    expect(ex.limitMaxCount).toBeNull();
    expect(ex.purchaseLimitText).toBe("お一人様1点まで");
    // 応募回数の記載（1人1回）は応募制限のまま
    const ok = validateExtraction(normalizeExtraction({ ...base, limit_basis: "person", limit_max_count: 1, purchase_limit_text: "お一人様1回限り応募可" }, NOW), null);
    expect(ok.limitBasis).toBe("person");
  });

  it("原文に無いURLは取り除く。原文にあるURLは残す。形式が不正なURLは正規化で空になる", () => {
    const keep = validateExtraction(normalizeExtraction({ ...base, apply_url: "https://example.invalid/apply" }, NOW), SOURCE);
    expect(keep.applyUrl).toBe("https://example.invalid/apply");
    const drop = validateExtraction(normalizeExtraction({ ...base, apply_url: "https://evil.invalid/x", announcement_url: "javascript:alert(1)" }, NOW), SOURCE);
    expect(drop.applyUrl).toBe("");
    expect(drop.announcementUrl).toBe("");
    expect(drop.issues.some((i) => i.field === "applyUrl")).toBe(true);
  });

  it("購入を伴わないプレゼント企画は、抽選販売ではない可能性として注意する", () => {
    const ex = validateExtraction(normalizeExtraction(base, NOW), "フォローとリポストで抽選で1名様にBOXが当たるプレゼントキャンペーン");
    expect(ex.issues.some((i) => i.field === "general" && i.message.includes("プレゼント"))).toBe(true);
    expect(validateExtraction(normalizeExtraction(base, NOW), "抽選販売のお知らせ。プレゼントではありません。購入は店頭").issues.some((i) => i.field === "general")).toBe(false);
  });

  it("検証してもAIの値を創作しない: 問題のない結果はそのまま", () => {
    const e = normalizeExtraction({ ...base, apply_deadline: d(11, 10, 23, 59) }, NOW);
    const v = validateExtraction(e, SOURCE);
    expect(v.applyDeadline).toEqual(e.applyDeadline);
    expect(v.items).toEqual(e.items);
    expect(v.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------- フィードバック（差分）
describe("AI解析と最終登録内容の比較（変更しただけでAIの誤認識とは断定しない）", () => {
  const ex: ExtractedLottery = normalizeExtraction(
    { ...base, store_name: "三宮店", apply_start: d(11, 5, 10, 0), apply_deadline: d(11, 10, 23, 59), result_date: d(11, 13), receive_method: "store", limit_basis: "person", limit_max_count: 1 },
    NOW,
  );
  const ai = aiSnapshot(ex);
  const input = (over: Partial<LotteryInput> = {}): LotteryInput => ({
    chain: { id: null, name: "サンプル電機" },
    store: { id: null, name: "三宮店", prefecture: "" },
    multiMode: "single",
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: null, name: "拡張パック「ひかりの森」" }, quantity: 1, unit: "box" }],
    applyStart: { precision: "date_time", date: "2026-11-05", time: "10:00" },
    applyDeadline: { precision: "date_time", date: "2026-11-10", time: "23:59" },
    resultDate: { precision: "date_only", date: "2026-11-13", time: "" },
    procedureDeadline: { precision: "unknown", date: "", time: "" },
    receiveMethod: "store",
    applyMethod: "unknown",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "person",
    limitMaxCount: 1,
    memo: "",
    applications: [],
    appliedAt: "",
    ...over,
  });

  it("無修正で登録: すべて「そのまま採用」。修正・補完・誤認識は0", () => {
    const r = compareFeedback(ai, inputSnapshot(input()), inputSnapshot(input()), null);
    expect(r.modified + r.supplemented + r.normalized + r.explicitError).toBe(0);
    expect(r.adopted).toBeGreaterThanOrEqual(7);
    expect(r.fields.applyDeadline?.status).toBe("adopted");
  });

  it("一部を修正: 応募締切の時刻を23:59→20:00に変更 →「変更された」。理由を選ばなければ誤認識とは数えない", () => {
    const final = input({ applyDeadline: { precision: "date_time", date: "2026-11-10", time: "20:00" } });
    const r = compareFeedback(ai, inputSnapshot(input()), inputSnapshot(final), null);
    expect(r.fields.applyDeadline).toMatchObject({ status: "modified" });
    expect(r.fields.applyDeadline?.explicit).toBeUndefined();
    expect(r.modified).toBe(1);
    expect(r.explicitError).toBe(0);
  });

  it("利用者が「AIの読み取りが間違っていた」を選んだ場合だけ、修正した項目が誤認識として数えられる（補完は数えない）", () => {
    const final = input({ applyDeadline: { precision: "date_time", date: "2026-11-10", time: "20:00" }, applyMethod: "web" });
    const r = compareFeedback(ai, inputSnapshot(input()), inputSnapshot(final), "ai_wrong");
    expect(r.fields.applyDeadline).toMatchObject({ status: "modified", explicit: true, reason: "ai_wrong" });
    expect(r.fields.applyMethod).toMatchObject({ status: "supplemented", reason: "ai_wrong" });
    expect(r.fields.applyMethod?.explicit).toBeUndefined();
    expect(r.explicitError).toBe(1);
    const other = compareFeedback(ai, inputSnapshot(input()), inputSnapshot(final), "other_source");
    expect(other.explicitError).toBe(0);
    expect(other.fields.applyDeadline?.reason).toBe("other_source");
  });

  it("AIが未抽出の項目を補完: 購入期限を利用者が入力 →「補完」", () => {
    const final = input({ procedureDeadline: { precision: "date_only", date: "2026-11-20", time: "" } });
    const r = compareFeedback(ai, inputSnapshot(input()), inputSnapshot(final), null);
    expect(r.fields.procedureDeadline).toMatchObject({ status: "supplemented" });
    expect(r.supplemented).toBe(1);
  });

  it("マスター照合で正式名称に正規化され、利用者がそのまま採用: 「正規化」（修正にも補完にも数えない）", () => {
    const filled = input({ items: [{ product: { id: "p1", name: "テスト拡張パック「ひかりの森」" }, quantity: 1, unit: "box" }] });
    const r = compareFeedback(ai, inputSnapshot(filled), inputSnapshot(filled), null);
    expect(r.fields.items).toMatchObject({ status: "normalized" });
    expect(r.normalized).toBe(1);
    expect(r.modified).toBe(0);
    // 利用者が正規化後の値をさらに変えたら「変更」
    const changed = input({ items: [{ product: { id: "p2", name: "別の商品" }, quantity: 1, unit: "box" }] });
    expect(compareFeedback(ai, inputSnapshot(filled), inputSnapshot(changed), null).fields.items?.status).toBe("modified");
  });

  it("AIが系列を出さず、アプリが店舗名の先頭から補った値を利用者が採用: 利用者の補完ではなく「正規化」", () => {
    const noChain = aiSnapshot(normalizeExtraction({ ...base, chain_name: "", store_name: "サンプル電機 三宮店" }, NOW));
    const filled = input();
    const r = compareFeedback(noChain, inputSnapshot(filled), inputSnapshot(filled), null);
    expect(r.fields.chain?.status).toBe("normalized");
  });

  it("初期値（未確認）のままの応募方法・受取方法は、利用者の補完として数えない", () => {
    const final = input({ applyMethod: "web", unconfirmedFields: ["applyMethod"] });
    const r = compareFeedback(ai, inputSnapshot(input()), inputSnapshot(final), null);
    expect(r.fields.applyMethod).toBeUndefined();
  });

  it("全角半角・空白の違いだけの変更は、変更に数えない", () => {
    const final = input({ store: { id: null, name: "三宮 店", prefecture: "" }, chain: { id: null, name: "サンプル電機" } });
    expect(compareFeedback(ai, inputSnapshot(input()), inputSnapshot(final), null).fields.store?.status).toBe("adopted");
  });
});

// ---------------------------------------------------------------- マスター照合
describe("マスター照合（別表記・候補・自動統合しない）", () => {
  const data: AppData = createMockData(NOW);
  const chains = [
    { id: "j", name: "上新電機", aliases: ["Joshin", "ジョーシン"] },
    { id: "k", name: "ケーズデンキ" },
    { id: "x", name: "上新電機サービス" },
  ];

  it("別表記（Joshin／ジョーシン）で系列に一致する。表記の揺れ（全角半角・大文字小文字・空白）も吸収", () => {
    expect(matchChain("Joshin", chains).item?.id).toBe("j");
    expect(matchChain("ＪＯＳＨＩＮ", chains).item?.id).toBe("j");
    expect(matchChain("ジョーシン", chains).kind).toBe("alias");
    expect(matchChain("上新電機", chains).kind).toBe("exact");
  });

  it("名称が似ているだけ・長さが大きく違う部分一致は、自動で選ばず候補だけを返す（異なる系列を統合しない）", () => {
    const m = matchChain("上新", chains);
    expect(m.item).toBeNull();
    const fuzzy = matchChain("ケーズデンギ", chains);
    expect(fuzzy.item).toBeNull();
    expect(fuzzy.candidates.map((c) => c.id)).toContain("k");
    expect(matchChain("全く違う系列", chains)).toMatchObject({ kind: "none", item: null, candidates: [] });
  });

  it("店舗: 別表記・系列名つきの表記で一致し、別の系列の同名店舗には一致しない", () => {
    const stores = [
      { id: "s1", chainId: "j", name: "三宮店", prefecture: "兵庫県", aliases: ["神戸三宮店"] },
      { id: "s2", chainId: "k", name: "三宮店", prefecture: "兵庫県" },
    ];
    expect(matchStore("神戸三宮店", "j", stores, "上新電機").item?.id).toBe("s1");
    expect(matchStore("上新電機 三宮店", "j", stores, "上新電機").item?.id).toBe("s1");
    expect(matchStore("三宮店", "k", stores, "ケーズデンキ").item?.id).toBe("s2");
    expect(matchStore("三宮店", null, stores).item).toBeNull();
  });

  it("商品: ブランド名の接頭辞・数量・入数の表記を除いて照合する", () => {
    expect(cleanProductName("ポケモンカードゲーム 拡張パック「ひかりの森」 1BOX（30パック入り）")).toBe(cleanProductName("拡張パック「ひかりの森」"));
    const products = [
      { id: "p1", officialName: "拡張パック「ひかりの森」", aliases: ["ひかりの森"], code: "", packsPerBox: 30 },
      { id: "p2", officialName: "拡張パック「ひかりの海」", aliases: [], code: "", packsPerBox: 30 },
    ];
    expect(matchProduct("ポケモンカードゲーム 拡張パック「ひかりの森」 1BOX（30パック入り）", "", products).item?.id).toBe("p1");
    expect(matchProduct("ひかりの森", "", products).kind).toBe("alias");
    // 似ているだけの別商品（森/海）は自動で選ばない
    const near = matchProduct("拡張パック「ひかりの湖」", "", products);
    expect(near.item).toBeNull();
    expect(near.candidates.length).toBeGreaterThan(0);
  });

  it("下書き: 系列が空で店舗名の先頭が別表記なら分ける。候補は一覧に入り、自動選択されない", () => {
    const withAlias: AppData = { ...data, chains: data.chains.map((c) => (c.id === "c1" ? { ...c, aliases: ["ジョーシン"] } : c)) };
    const draft = buildDraft(normalizeExtraction({ ...base, chain_name: "", store_name: "ジョーシン 三宮店" }, NOW), withAlias);
    expect(draft.input.chain.id).toBe("c1");
    expect(draft.input.store.name).toBe("三宮店");
    expect(draft.flags.chain).toContain("推定");
    const unsure = buildDraft(normalizeExtraction({ ...base, products: [{ name: "拡張パック「ひかりの湖」", code: "", quantity: 1, unit: "box" }] }, NOW), data);
    expect(unsure.input.items[0].product.id).toBeNull();
  });
});
