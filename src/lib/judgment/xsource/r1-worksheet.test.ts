// @vitest-environment node
/** Phase 2: R1 の独立gold作成支援（架空のページ・架空のgold。AIの出力から正解を作らない）。 */
import { describe, expect, it } from "vitest";
import { assertNoGoldLeak, validateGold } from "./compare-eval";
import { composeR1Cases, pageCandidate, validatePageGold, worksheetMarkdown, type R1PageGold } from "./r1-worksheet";

const html = (shop: string, product: string, end: string, extra = "") => `<html><body><h1 class="heading01">【${shop}】${product} 抽選</h1><h2>受付・チケット情報</h2><section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">${product} 1BOX</h4><p class="event-detail-ticket-card__text">受付期間 ${end}まで。お一人様1回まで。</p></section>${extra}</body></html>`;
const PAGES = [
  { n: 1, url: "https://shop-a.example.invalid/e/1", html: html("新宿本店", "拡張パック", "11月30日") },
  { n: 2, url: "https://shop-b.example.invalid/e/2", html: html("渋谷店", "拡張パック", "11月29日") },
  { n: 3, url: "https://shop-c.example.invalid/e/3", html: html("大阪店", "ハイクラスパック", "12月3日") },
  { n: 4, url: "https://shop-d.example.invalid/e/4", html: html("名古屋店", "拡張パック", "12月5日") },
];
const gold = (n: number, over: Partial<R1PageGold> = {}): R1PageGold => {
  const shop = ["新宿本店", "渋谷店", "大阪店", "名古屋店"][n - 1];
  return { n, verified: { by: "human", at: "2026-11-25", basis: "公式ページを人が目視で確認（架空のテスト）" }, store: shop, product: n === 3 ? "ハイクラスパック" : "拡張パック", applyEnd: ["2026-11-30", "2026-11-29", "2026-12-03", "2026-12-05"][n - 1], applyUnit: null, region: null, evidence: [{ quote: `【${shop}】` }], ...over };
};

describe("ページごとの確認資料（候補は機械抽出・未確認）", () => {
  it("店舗・商品・締切の候補と、人が見るべき点（複数の締切候補・構造を認識できない・店舗が無い）を出す。AIの出力は含めない", () => {
    const c = pageCandidate(PAGES[0]);
    expect(c).toMatchObject({ n: 1, storeCandidate: "新宿本店", recognized: true });
    expect(c.deadlineCandidates.some((d) => d.md === "11/30")).toBe(true);
    const bad = pageCandidate({ n: 9, url: "https://x.example.invalid/", html: "<html><body><p>ただのテキスト。11月1日 12月2日 〆</p></body></html>" });
    expect(bad.attention.length).toBeGreaterThan(0);
    const md = worksheetMarkdown([c, bad]);
    expect(md).toContain("機械抽出で**未確認**");
    expect(md).toContain("AIの出力・旧方式の結果は見ない");
    expect(md).toContain("要確認");
  });
});

describe("ページ単位のgoldの検査と、案件の組み立て", () => {
  it("人の確認・根拠の引用（ページの本文に実在）が無いgoldは拒否する", () => {
    expect(validatePageGold([gold(1), gold(2)], PAGES).ok).toBe(true);
    const r = validatePageGold([gold(1, { verified: { by: "ai" as never, at: "", basis: "" } }), gold(2, { evidence: [{ quote: "ページに無い文章" }] }), gold(3, { evidence: [] }), gold(4, { applyEnd: "12/5" })], PAGES);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
    expect(validatePageGold([gold(1, { exclude: true, evidence: [] })], PAGES).ok).toBe(true); // 除外は検査しない
  });
  it("案件を決定的に組み立てる: 同じ入力なら同じ結果・先頭リンクが毎回同じにならない・goldは独立性の検査を通り、入力に合言葉が混ざらない", () => {
    const g = [1, 2, 3, 4].map((n) => gold(n));
    const a = composeR1Cases({ pages: PAGES, gold: g, cases: 6, linksPerCase: 3, at: "2026-11-25" });
    const b = composeR1Cases({ pages: PAGES, gold: g, cases: 6, linksPerCase: 3, at: "2026-11-25" });
    expect(a).toEqual(b);
    expect(a.cases).toHaveLength(6);
    expect(a.cases.every((c) => c.pages.length === 3 && c.linkMap.length === 3)).toBe(true);
    expect(new Set(a.cases.map((c) => c.pages[0].url)).size).toBeGreaterThan(1);
    expect(validateGold(a.gold)).toEqual({ ok: true, errors: [] });
    expect(assertNoGoldLeak(a.cases.flatMap((c) => [c.postText, ...c.pages.map((p) => p.text)]), a.gold).ok).toBe(true);
    // 投稿の文面は、gold の店舗・商品（実投稿にも書かれる事実）を含むが、gold の根拠（引用）や合言葉は含まない
    expect(a.cases[0].postText).toContain("《");
    // 各 gold の機会は、案件内のリンクの順番（pageIndex）と一致する
    a.gold.forEach((gc, i) => gc.opportunities.forEach((o, k) => { expect(o.pageIndex).toBe(k); expect(o.url).toBe(a.cases[i].pages[k].url); }));
  });
  it("除外したページは使わない。有効なページが無ければ案件を作らない", () => {
    const g = [gold(1, { exclude: true }), gold(2), gold(3)];
    const r = composeR1Cases({ pages: PAGES, gold: g, cases: 4, linksPerCase: 3, at: "2026-11-25" });
    expect(r.cases.flatMap((c) => c.pages.map((p) => p.url))).not.toContain(PAGES[0].url);
    expect(composeR1Cases({ pages: PAGES, gold: [gold(1, { exclude: true })], cases: 2, at: "x" }).cases).toEqual([]);
  });
});
