import { describe, expect, it } from "vitest";
import { aggregateBox, boxCore, boxKey, classifyBoxCondition, computeBoxMarket, extractCodes, type BoxProductIdentity } from "@/lib/box-market";
import { DEFAULT_BOX_SETTINGS, indexMarket, summarizeBoxes, totalsOfBoxes, unitBuyback, latestPrices, type BoxLotRow, type BoxMarketRow, type BoxPriceRow, emptyCounts } from "@/lib/box-collection";
import { cardPriceState, lastPriceDate, summarizeCards, totalsOf, type CardRow, type HoldingRow, type MarketPriceRow, type MarketStatusRow, type PriceRow } from "@/lib/collection";
import type { MarketRow } from "@/lib/market-price";

// すべて架空のデータ
const card = (id: string): CardRow => ({ id, name: `テストカード${id}`, cardNumber: "001/100", setCode: "TST", rarity: "RR", cardType: "", productName: "テスト弾", imagePath: null, thumbPath: null, imageSha: null, sourceUrl: null, analysisRunId: null, createdAt: "2026-11-01T00:00:00Z" });
const hold = (cardId: string, quantity: number, condition = "A"): HoldingRow => ({ id: `h${cardId}${condition}`, cardId, quantity, acquiredOn: "2026-11-01", unitPriceYen: 300, source: "", condition, note: "", purchaseId: null, createdAt: "2026-11-01T00:00:00Z" });
const manual = (cardId: string, kind: "sale" | "buyback", amountYen: number): PriceRow => ({ id: `p${cardId}${kind}`, cardId, kind, amountYen, confirmedOn: "2026-11-02", source: "手動", sourceUrl: null, createdAt: "2026-11-02T00:00:00Z" });
const mk = (cardId: string, kind: "sale" | "buyback", medianYen: number, grade: "A" | "B" | "C" = "A", fetchedAt = "2026-11-08T03:00:00Z"): MarketPriceRow => ({ cardId, kind, conditionGrade: grade, medianYen, lowYen: medianYen, highYen: medianYen, sampleCount: 3, outlierCount: 0, shops: [], source: "ポケカ価格比較", sourceUrl: null, csvUpdatedAt: null, fetchedAt });
const st = (subjectId: string, status: MarketStatusRow["status"], reason = ""): MarketStatusRow => ({ subjectId, status, saleOk: false, buybackOk: false, reason, checkedAt: "2026-11-08T03:00:00Z" });

describe("Stage 7F: カードの取得価格を集計へ反映", () => {
  it("手動価格が無いカードは、取得した状態Aの相場で評価額・合計に反映される", () => {
    const rows = summarizeCards([card("1")], [hold("1", 2)], [], [], null, { market: [mk("1", "sale", 1000), mk("1", "buyback", 600)] });
    expect(rows[0].saleSource).toBe("market");
    expect(rows[0].buybackSource).toBe("market");
    expect(rows[0].saleValue).toBe(2000);
    expect(rows[0].buybackValue).toBe(1200);
    const t = totalsOf(rows);
    expect(t.saleTotal).toBe(2000);
    expect(t.buybackTotal).toBe(1200);
    expect(t.saleMissingKinds).toBe(0);
  });

  it("手動価格が優先され、取得した相場で上書きされない（販売・買取は独立に判定）", () => {
    const rows = summarizeCards([card("1")], [hold("1", 1)], [manual("1", "sale", 5000)], [], null, { market: [mk("1", "sale", 1000), mk("1", "buyback", 600)] });
    expect(rows[0].saleSource).toBe("manual");
    expect(rows[0].saleValue).toBe(5000);
    expect(rows[0].sale?.amountYen).toBe(5000);
    // 買取は手動が無いので取得した相場
    expect(rows[0].buybackSource).toBe("market");
    expect(rows[0].buybackValue).toBe(600);
  });

  it("状態B: 実価格があれば実価格、なければ取得した基準相場×倍率（推定）", () => {
    const base = [mk("1", "sale", 1000)];
    const est = summarizeCards([card("1")], [hold("1", 1, "B")], [], [], null, { market: base });
    expect(est[0].saleValue).toBe(850);
    expect(est[0].saleLines[0].source).toBe("multiplier");
    const act = summarizeCards([card("1")], [hold("1", 1, "B")], [], [], null, { market: [...base, mk("1", "sale", 720, "B")] });
    expect(act[0].saleValue).toBe(720);
    expect(act[0].saleLines[0].source).toBe("market");
    // 状態Cの実価格が無ければ推定（実価格として扱わない）
    const c = summarizeCards([card("1")], [hold("1", 1, "C")], [], [], null, { market: [...base, mk("1", "sale", 720, "B")] });
    expect(c[0].saleValue).toBe(650);
    expect(c[0].saleLines[0].source).toBe("multiplier");
  });

  it("価格が無いカードは0円ではなく null（合計は未取得の種類としてカウント）", () => {
    const rows = summarizeCards([card("1")], [hold("1", 1)], [], [], null, {});
    expect(rows[0].saleValue).toBeNull();
    expect(rows[0].saleSource).toBeNull();
    expect(totalsOf(rows).saleMissingKinds).toBe(1);
  });

  it("購入額（実際に支払った金額）は相場の影響を受けない", () => {
    const rows = summarizeCards([card("1")], [hold("1", 3)], [], [], null, { market: [mk("1", "sale", 9999)] });
    expect(rows[0].costTotal).toBe(900);
  });

  it("価格の最終取得日は取得した相場の日付（日本時間）も対象", () => {
    const rows = summarizeCards([card("1")], [hold("1", 1)], [], [], null, { market: [mk("1", "sale", 1000, "A", "2026-11-08T16:00:00Z")] });
    expect(lastPriceDate(rows)).toBe("11/9");
  });
});

describe("Stage 7F: 価格の取得状況", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  const row = (o: Partial<Parameters<typeof cardPriceState>[0]>) => ({ saleSource: null, buybackSource: null, saleMarket: null, buybackMarket: null, marketStatus: null, ...o }) as Parameters<typeof cardPriceState>[0];
  it("未取得／CSVに対象なし／照合失敗を区別する", () => {
    expect(cardPriceState(row({}), now).label).toBe("未取得");
    expect(cardPriceState(row({ marketStatus: st("1", "unlisted") }), now).label).toBe("CSVに対象カードなし");
    expect(cardPriceState(row({ marketStatus: st("1", "ambiguous", "同じ番号に複数の候補があります") }), now)).toMatchObject({ label: "商品照合失敗", level: "none" });
    expect(cardPriceState(row({ marketStatus: st("1", "insufficient") }), now).label).toBe("商品照合失敗");
  });
  it("販売のみ・買取のみは注意、手動のみ／取得成功は問題なし", () => {
    const m = mk("1", "sale", 1000);
    expect(cardPriceState(row({ saleSource: "market", saleMarket: m }), now)).toMatchObject({ level: "warn", label: "販売価格のみ" });
    expect(cardPriceState(row({ buybackSource: "market", buybackMarket: mk("1", "buyback", 500) }), now)).toMatchObject({ level: "warn", label: "買取価格のみ" });
    expect(cardPriceState(row({ saleSource: "manual", buybackSource: "manual" }), now)).toMatchObject({ level: "ok", label: "手動価格" });
    expect(cardPriceState(row({ saleSource: "market", buybackSource: "market", saleMarket: m, buybackMarket: mk("1", "buyback", 500) }), now)).toMatchObject({ level: "ok", label: "取得成功" });
  });
  it("取得から7日以上たった価格は古いと示す（消さない）", () => {
    const old = mk("1", "sale", 1000, "A", "2026-11-01T00:00:00Z");
    const s = cardPriceState(row({ saleSource: "market", buybackSource: "market", saleMarket: old, buybackMarket: old }), now);
    expect(s.level).toBe("warn");
    expect(s.label).toContain("古い");
  });
});

// ---------------------------------------------------------------- BOX
const R = (o: Partial<MarketRow>): MarketRow => ({ shopKey: "s1", shop: "店1", type: "box", kind: "buy", set: "", no: "", name: "", rarity: "", condition: "未開封", price: 1000, inStock: true, url: "", scrapedAt: "2026-11-08T06:08+09:00", ...o });
const P = (id: string, name: string, code: string | null = null, aliases: string[] = []): BoxProductIdentity => ({ id, name, code, aliases });

describe("Stage 7F: BOXの名称の正規化と状態の判定", () => {
  it("括弧つきの商品コードを取り出し、飾りの語を除く", () => {
    expect(extractCodes("拡張パック『テストスパーク』(TS1)")).toEqual(["TS1"]);
    expect(boxCore("拡張パック『テストスパーク』(TS1)")).toBe("テストスパーク");
    expect(boxCore("MEGA 拡張パック テストスパーク BOX")).toBe("テストスパーク");
    expect(boxCore("スカーレット＆バイオレット 拡張パックデラックス テストスパーク")).toBe("デラックステストスパーク");
    expect(boxKey("テスト スパーク")).toBe("テストスパーク");
  });
  it("シュリンクの有無が明示されたものだけ実価格にする", () => {
    expect(classifyBoxCondition("シュリンクなし")).toBe("no_shrink");
    expect(classifyBoxCondition("シュリンク付き")).toBe("shrink");
    expect(classifyBoxCondition("未開封")).toBe("base");
    expect(classifyBoxCondition("新品")).toBe("base");
    expect(classifyBoxCondition("状態A-")).toBeNull();
    expect(classifyBoxCondition("中古")).toBeNull();
  });
  it("集計: 買取は店舗ごとの最高値、販売は在庫ありのみ。状態A-は使わない", () => {
    const rows = [
      R({ shopKey: "a", kind: "buy", condition: "未開封", price: 5000 }),
      R({ shopKey: "b", kind: "buy", condition: "未開封", price: 5500 }),
      R({ shopKey: "a", kind: "buy", condition: "シュリンクなし", price: 4000 }),
      R({ shopKey: "c", kind: "sell", condition: "新品", price: 8000, inStock: false }),
      R({ shopKey: "d", kind: "sell", condition: "未開封", price: 8500 }),
      R({ shopKey: "d", kind: "sell", condition: "状態A-", price: 7000 }),
    ];
    const e = aggregateBox(rows);
    const get = (kind: string, basis: string) => e.find((x) => x.kind === kind && x.basis === basis)?.stat;
    expect(get("buyback", "base")).toMatchObject({ medianYen: 5250, samples: 2 });
    expect(get("buyback", "no_shrink")).toMatchObject({ medianYen: 4000, samples: 1 });
    expect(get("sale", "base")).toMatchObject({ medianYen: 8500, samples: 1 }); // 在庫なし(c)と状態A-は除外
    expect(get("sale", "shrink")).toBeUndefined();
  });
});

describe("Stage 7F: BOXの商品照合", () => {
  const rows = [
    R({ name: "拡張パック『テストスパーク』(TS1)", shopKey: "a", kind: "sell", price: 9000 }),
    R({ name: "MEGA 拡張パック テストスパーク BOX", shopKey: "b", kind: "buy", price: 7000 }),
    R({ name: "テストスパーク(ポケモンセンターセット)", shopKey: "a", kind: "sell", price: 18000 }),
    R({ name: "デラックス テストスパーク", shopKey: "c", kind: "buy", price: 12000 }),
    R({ name: "拡張パック『ダミーフレア』(DF1)", shopKey: "a", kind: "sell", price: 6000 }),
  ];
  const products = [P("p1", "テストスパーク", "TS1"), P("p2", "ダミーフレア", "DF1"), P("p3", "存在しないBOX", "NX1")];
  const find = (res: ReturnType<typeof computeBoxMarket>, id: string) => res.results.find((r) => r.productId === id)!;

  it("商品コード・商品名の一致は自動で確定し、限定版・デラックスは混ぜない", () => {
    const res = computeBoxMarket(products, rows);
    const p1 = find(res, "p1");
    expect(p1.status).toBe("updated");
    expect(p1.method).toBe("code");
    expect(p1.keys).toHaveLength(2); // コードつきの表記と「MEGA 拡張パック…BOX」の表記
    expect(p1.prices.find((x) => x.kind === "sale" && x.basis === "base")?.stat.medianYen).toBe(9000); // センターセット(18000)は混ざらない
    expect(p1.prices.find((x) => x.kind === "buyback" && x.basis === "base")?.stat.medianYen).toBe(7000); // デラックス(12000)は混ざらない
    expect(find(res, "p2").status).toBe("updated");
    expect(find(res, "p3").status).toBe("unlisted");
    expect(res.summary).toMatchObject({ total: 3, autoMatched: 2, priced: 2, unlisted: 1, salePriced: 2, buybackPriced: 1 });
  });

  it("候補の確認は、確認対象の商品だけに出し、名称の一部一致で自動登録しない", () => {
    const res = computeBoxMarket([P("p1", "テストスパーク"), P("p2", "ダミーフレア")], [R({ name: "テストスパーク 特別セット", kind: "sell", price: 20000 }), R({ name: "ダミーフレア カートン", kind: "buy", price: 70000 })], {}, new Set(["p1"]));
    const p1 = find(res, "p1");
    expect(p1.status).toBe("ambiguous");
    expect(p1.prices).toEqual([]);
    expect(p1.candidates[0]).toMatchObject({ name: "テストスパーク 特別セット", saleYen: 20000 });
    expect(find(res, "p2").status).toBe("unlisted"); // 確認対象ではないので候補も出さない
    expect(res.summary.needsReview).toBe(1);
  });

  it("利用者が確定した対応が優先され、CSVから消えた対応は再確認として数える", () => {
    const csv = [R({ name: "テストスパーク 特別セット", kind: "sell", price: 20000 })];
    const key = boxKey("テストスパーク 特別セット");
    const res = computeBoxMarket([P("p1", "テストスパーク")], csv, { [key]: "p1", [boxKey("消えた商品")]: "p1" });
    const p1 = find(res, "p1");
    expect(p1).toMatchObject({ status: "updated", method: "manual" });
    expect(res.summary).toMatchObject({ linkMatched: 1, autoMatched: 0, staleLinks: 1 });
  });

  it("同じ名称が複数の商品に当てはまるときは確定しない", () => {
    const res = computeBoxMarket([P("p1", "テストスパーク"), P("p2", "テスト スパーク")], [R({ name: "テストスパーク", kind: "buy", price: 7000 })], {}, new Set(["p1", "p2"]));
    expect(res.results.every((r) => r.status !== "updated")).toBe(true);
  });

  it("別名で一致する", () => {
    const res = computeBoxMarket([P("p1", "テストスパークex", null, ["テストスパーク"])], [R({ name: "拡張パック テストスパーク", kind: "buy", price: 7000 })]);
    expect(res.results[0]).toMatchObject({ status: "updated", method: "alias" });
  });

  it("掲載はあるが売切・対象外の状態のみなら、価格なしとして残す（0円にしない）", () => {
    const res = computeBoxMarket([P("p1", "テストスパーク")], [R({ name: "テストスパーク", kind: "sell", condition: "状態A-", price: 5000 })]);
    expect(res.results[0].status).toBe("no_price");
    expect(res.results[0].prices).toEqual([]);
  });

  it("同じCSVを何度照合しても結果は同じ（冪等）", () => {
    const a = computeBoxMarket(products, rows);
    const b = computeBoxMarket(products, rows);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("Stage 7F: BOXの価格の優先順位とシュリンク補正", () => {
  const mrow = (basis: BoxMarketRow["basis"], medianYen: number, sampleCount = 3, kind: BoxMarketRow["kind"] = "buyback"): BoxMarketRow => ({ productId: "A", kind, basis, medianYen, lowYen: medianYen, highYen: medianYen, sampleCount, outlierCount: 0, shops: [], source: "ポケカ価格比較", sourceUrl: null, csvUpdatedAt: null, fetchedAt: "2026-11-08T03:00:00Z", matchMethod: "name" });
  const bprice = (state: BoxPriceRow["state"], amountYen: number): BoxPriceRow => ({ id: `${state}`, productId: "A", state, amountYen, confirmedOn: "2026-11-05", source: "手動", createdAt: "2026-11-05T00:00:00Z" });
  const none = latestPrices([]);

  it("手動の相場が無いときだけ取得した相場を使う: シュリンクあり=基準×100%、なし=基準×85%", () => {
    const m = indexMarket([mrow("base", 10000)]);
    expect(unitBuyback("A", "shrink", none, DEFAULT_BOX_SETTINGS, m)).toMatchObject({ amount: 10000, source: "market", basis: "adjusted", samples: 3 });
    expect(unitBuyback("A", "no_shrink", none, DEFAULT_BOX_SETTINGS, m)).toMatchObject({ amount: 8500, source: "market", basis: "adjusted" });
    expect(unitBuyback("A", "unknown", none, DEFAULT_BOX_SETTINGS, m)).toMatchObject({ amount: 10000, source: "market", basis: "base" });
  });
  it("CSVにシュリンクなしが明示された実価格があれば、倍率より優先する", () => {
    const m = indexMarket([mrow("base", 10000), mrow("no_shrink", 7000)]);
    expect(unitBuyback("A", "no_shrink", none, DEFAULT_BOX_SETTINGS, m)).toMatchObject({ amount: 7000, basis: "actual", source: "market" });
    expect(unitBuyback("A", "shrink", none, DEFAULT_BOX_SETTINGS, m).amount).toBe(10000);
  });
  it("手動の相場がある商品は取得した相場で上書きされない", () => {
    const m = indexMarket([mrow("base", 10000), mrow("no_shrink", 7000)]);
    const latest = latestPrices([bprice(null, 12000)]);
    expect(unitBuyback("A", "no_shrink", latest, DEFAULT_BOX_SETTINGS, m)).toMatchObject({ amount: 10200, source: "manual", basis: "adjusted" });
    expect(unitBuyback("A", "shrink", latest, DEFAULT_BOX_SETTINGS, m)).toMatchObject({ amount: 12000, source: "manual" });
  });
  it("基準にできる価格が無い（販売のみ・状態A-のみ）商品は評価に使わない", () => {
    const m = indexMarket([mrow("base", 9000, 1, "sale")]);
    expect(unitBuyback("A", "shrink", none, DEFAULT_BOX_SETTINGS, m)).toMatchObject({ amount: null, source: null, basis: "none" });
  });
  it("集計: 取得した相場を使ったBOX数と最少の店舗数、未取得は0円にしない", () => {
    const lot = (id: string, productId: string): BoxLotRow => ({ id, productId, sourceKind: "manual", purchaseItemId: null, acquiredOn: "2026-11-01", chainId: null, storeId: null, storeLabel: "", actualUnitPrice: 5000, marketUnitPrice: null, marketPriceSource: "", marketPriceDate: null, note: "", archived: false, createdAt: "2026-11-01T00:00:00Z" });
    const products = [{ id: "A", name: "BOX A", releaseDate: null }, { id: "B", name: "BOX B", releaseDate: null }];
    const bal = new Map([["l1", { ...emptyCounts(), shrink: 2 }], ["l2", { ...emptyCounts(), shrink: 1 }]]);
    const rows = summarizeBoxes(products, [lot("l1", "A"), lot("l2", "B")], bal, [], DEFAULT_BOX_SETTINGS, [mrow("base", 10000, 1)]);
    const a = rows.find((r) => r.productId === "A")!;
    expect(a).toMatchObject({ buybackTotal: 20000, marketQty: 2, marketMinSamples: 1, refUnit: 10000, priceDate: "2026-11-08" });
    const b = rows.find((r) => r.productId === "B")!;
    expect(b).toMatchObject({ buybackTotal: null, buybackMissingQty: 1, marketQty: 0 });
    expect(totalsOfBoxes(rows)).toMatchObject({ buybackTotal: 20000, buybackMissingQty: 1, marketQty: 2 });
  });
});
