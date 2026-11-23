// @vitest-environment node
/** 日別相場調査結果（統合・グループ化・絞り込み・日付・購入予定の有効期限）と、系列・店舗の「最後の入力」から5分間の初期選択、並び替えの追加分。 */
import { describe, expect, it } from "vitest";
import { cardKeyOf, filterDaily, groupByCard, groupByStore, isDay, jstDay, markActive, mergeDaily, shiftDay, type DailyRecord } from "./daily";
import { DEFAULT_PAIR_WINDOW_MS, defaultPair, latestInput, MARKET_SORT_MENU, MARKET_SORT_ORDER, marketSortHeading, nextMarketSort, rarityOrder, recentPairs, sortMarketCards } from "./zukan";

let n = 0;
const rec = (o: Partial<DailyRecord> = {}): DailyRecord => ({ source: "market", id: `r${++n}`, cardName: "ミロカロス", setName: "SV8", cardNumber: "100/106", rarity: "SAR", chainName: "トレカキャピタル", storeName: "垂水店", condition: "A", priceYen: 11000, note: "", createdAt: `2026-11-23T0${Math.min(n, 9)}:00:00Z`, ...o });

describe("日別の統合: 151図鑑と相場調査メモの記録", () => {
  it("同じカード・店舗・状態・価格が両方の記録元にあれば1行にまとめ（参照は両方）、価格・状態・店舗が違えば別の記録として残す。同じ記録元の同じ内容は統合しない", () => {
    const a = rec({ source: "zukan" });
    const b = rec({ source: "market" }); // 別の記録元の同じ内容
    const c = rec({ source: "market", priceYen: 9000 }); // 価格が違う
    const d = rec({ source: "market", condition: "B" }); // 状態が違う
    const e = rec({ source: "market", storeName: "梅田店" }); // 店舗が違う
    const f = rec({ source: "market" }); // 相場調査メモ内の同じ内容（別々に入力）
    const rows = mergeDaily([a, b, c, d, e, f]);
    expect(rows).toHaveLength(5);
    const merged = rows.find((r) => r.refs.length === 2)!;
    expect(merged.refs.map((r) => r.source).sort()).toEqual(["market", "zukan"]);
    expect(rows.filter((r) => r.refs.length === 1)).toHaveLength(4);
  });
  it("購入予定マーク（当日有効な記録）は、統合された行のどちらの記録に付いていても行が購入予定になる", () => {
    const a = rec({ source: "zukan" });
    const b = rec({ source: "market" });
    expect(mergeDaily([a, b], new Set([`market:${b.id}`]))[0].planned).toBe(true);
    expect(mergeDaily([a, b], new Set())[0].planned).toBe(false);
  });
  it("カードの同一性: セット・番号・レアリティが同じなら同じカード（表記・大文字小文字・空白の揺れを吸収）。同じポケモンでもセット・番号・レアリティが違えば別。セット・番号が無いときはカード名＋レアリティ", () => {
    expect(cardKeyOf(rec({ setName: "sv8", cardNumber: " 100/106", rarity: "sar" }))).toBe(cardKeyOf(rec()));
    expect(cardKeyOf(rec({ rarity: "SR" }))).not.toBe(cardKeyOf(rec()));
    expect(cardKeyOf(rec({ cardNumber: "101/106" }))).not.toBe(cardKeyOf(rec()));
    expect(cardKeyOf(rec({ cardName: "ミロカロスex", setName: "", cardNumber: "" }))).not.toBe(cardKeyOf(rec({ cardName: "ミロカロス", setName: "", cardNumber: "" })));
  });
});

describe("日別のグループ化・絞り込み", () => {
  it("カード別（既定）: ポケモンの図鑑番号の順。同じカード内は価格の安い順。同じポケモンでも別セットは別グループ。特定できないカードは最後", () => {
    const rows = mergeDaily([
      rec({ cardName: "ミュウex", setName: "151", cardNumber: "205/165", rarity: "SAR", priceYen: 5000 }),
      rec({ cardName: "フシギダネ", setName: "151", cardNumber: "001/165", rarity: "C", priceYen: 30 }),
      rec({ cardName: "ミロカロス", setName: "SV8", cardNumber: "100/106", rarity: "SAR", priceYen: 11000, storeName: "A店" }),
      rec({ cardName: "ミロカロス", setName: "SV8", cardNumber: "100/106", rarity: "SAR", priceYen: 9000, storeName: "B店" }),
      rec({ cardName: "ミロカロス", setName: "SV5", cardNumber: "050/066", rarity: "SAR", priceYen: 700, storeName: "C店" }),
      rec({ cardName: "ハイパーボール", setName: "S", cardNumber: "100/100", rarity: "U", priceYen: 10 }),
    ]);
    const g = groupByCard(rows);
    expect(g.map((x) => x.title)).toEqual(["フシギダネ", "ミュウex", "ミロカロス", "ミロカロス", "ハイパーボール"]); // No.1, 151, 350(ミロカロス)×2, 不明
    const milo = g.filter((x) => x.title === "ミロカロス");
    expect(milo).toHaveLength(2); // セットが違えば別のカード
    expect(milo.find((x) => x.card!.setName === "SV8")!.rows.map((r) => r.priceYen)).toEqual([9000, 11000]); // 安い順
  });
  it("店舗別: 系列→店舗の順。同じ店舗内はカード名→価格", () => {
    const rows = mergeDaily([rec({ chainName: "B系列", storeName: "z店", cardName: "ミュウex", setName: "151", cardNumber: "205/165" }), rec({ chainName: "A系列", storeName: "a店", cardName: "フシギダネ", setName: "151", cardNumber: "001/165", priceYen: 30 }), rec({ chainName: "A系列", storeName: "a店", cardName: "フシギダネ", setName: "151", cardNumber: "001/165", priceYen: 20, condition: "B" })]);
    const g = groupByStore(rows);
    expect(g.map((x) => x.title)).toEqual(["A系列 a店", "B系列 z店"]);
    expect(g[0].rows.map((r) => r.priceYen)).toEqual([20, 30]);
  });
  it("絞り込み: 状態ランク（複数選択）と購入予定のみ。条件を外すと全件", () => {
    const rows = mergeDaily([rec({ condition: "A" }), rec({ condition: "B", priceYen: 1 }), rec({ condition: "C", priceYen: 2 })], new Set(["market:" + "r" + (n - 1)]));
    expect(filterDaily(rows, { ranks: [], plannedOnly: false })).toHaveLength(3);
    expect(filterDaily(rows, { ranks: ["A", "C"], plannedOnly: false }).map((r) => r.condition).sort()).toEqual(["A", "C"]);
    expect(filterDaily(rows, { ranks: [], plannedOnly: true })).toHaveLength(1);
    expect(filterDaily(rows, { ranks: ["A"], plannedOnly: true })).toHaveLength(0);
  });
});

describe("日付（日本時間）と購入予定の有効期限", () => {
  it("日本時間の日付: UTCの前日でも日本では翌日（0:00をまたぐ境界）", () => {
    expect(jstDay(new Date("2026-11-22T14:59:59Z"))).toBe("2026-11-22");
    expect(jstDay(new Date("2026-11-22T15:00:00Z"))).toBe("2026-11-23");
  });
  it("日付の前後（月・年をまたぐ）と形式の検査", () => {
    expect(shiftDay("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(isDay("2026-11-23")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-1-3")).toBe(false);
  });
  it("購入予定は、マークした日（日本時間）が今日のときだけ有効。翌日以降は無効（記録は残る）", () => {
    expect(markActive("2026-11-23", "2026-11-23")).toBe(true);
    expect(markActive("2026-11-23", "2026-11-24")).toBe(false);
  });
});

describe("系列・店舗の「最後の入力」と5分間の初期選択", () => {
  const stamp = (at: string, chainName = "トレカキャピタル", storeName = "垂水店") => ({ chainName, storeName, at });
  const T = Date.parse("2026-11-23T10:00:00Z");
  it("最後の入力から5分未満は初期選択。ちょうど5分・それ以上・日時が不正・系列/店舗が空・履歴なしは空欄", () => {
    expect(defaultPair(stamp("2026-11-23T09:55:01Z"), T)).toEqual({ chainName: "トレカキャピタル", storeName: "垂水店" });
    expect(defaultPair(stamp("2026-11-23T09:55:00Z"), T)).toBeNull(); // 5分ちょうど
    expect(defaultPair(stamp("2026-11-23T09:50:00Z"), T)).toBeNull();
    expect(defaultPair(stamp("bad"), T)).toBeNull();
    expect(defaultPair(stamp("2026-11-23T09:59:00Z", "", "垂水店"), T)).toBeNull();
    expect(defaultPair(null, T)).toBeNull();
    expect(DEFAULT_PAIR_WINDOW_MS).toBe(300_000);
  });
  it("フォームを開き直すたびに評価される（同じ入力でも、時間が経てば空欄に戻る。履歴は保持）", () => {
    const s = stamp("2026-11-23T09:58:00Z");
    expect(defaultPair(s, T)).not.toBeNull(); // 2分後に開く
    expect(defaultPair(s, T + 4 * 60_000)).toBeNull(); // 6分後に開き直す
    const recs = [{ chainName: "A", storeName: "a店", surveyedOn: "2026-11-23", createdAt: "2026-11-23T09:58:00Z" }];
    expect(recentPairs(recs)).toEqual([{ chainName: "A", storeName: "a店" }]); // 履歴の候補は残る
  });
  it("最後の入力は、両方の記録元（151図鑑・相場調査メモ）を合わせた作成日時が最も新しいもの。系列か店舗が空の記録は対象にしない", () => {
    const l = latestInput([
      { chainName: "Z", storeName: "z店", createdAt: "2026-11-23T09:00:00Z" },
      { chainName: "A", storeName: "a店", createdAt: "2026-11-23T09:59:00Z" },
      { chainName: "", storeName: "新しいが系列なし", createdAt: "2026-11-23T09:59:30Z" },
    ]);
    expect(l).toEqual({ chainName: "A", storeName: "a店", at: "2026-11-23T09:59:00Z" });
    expect(latestInput([])).toBeNull();
  });
  it("履歴の並び: 調査日が同じなら、作成日時の新しい入力が先（直前に入力した店舗が先頭）", () => {
    const p = recentPairs([
      { chainName: "A", storeName: "a店", surveyedOn: "2026-11-23", createdAt: "2026-11-23T01:00:00Z" },
      { chainName: "B", storeName: "b店", surveyedOn: "2026-11-23", createdAt: "2026-11-23T02:00:00Z" },
    ]);
    expect(p.map((x) => x.storeName)).toEqual(["b店", "a店"]);
  });
});

describe("並び替えの追加（価格降順・レアリティ順・循環）", () => {
  const cards = [
    { id: "1", name: "a", setName: "s", cardNumber: "1", rarity: "R", createdAt: "2026-11-01T00:00:00Z" },
    { id: "2", name: "b", setName: "s", cardNumber: "2", rarity: "SAR", createdAt: "2026-11-02T00:00:00Z" },
    { id: "3", name: "c", setName: "s", cardNumber: "3", rarity: "", createdAt: "2026-11-03T00:00:00Z" },
    { id: "4", name: "d", setName: "s", cardNumber: "4", rarity: "UR", createdAt: "2026-11-04T00:00:00Z" },
    { id: "5", name: "e", setName: "s", cardNumber: "5", rarity: "ZZ", createdAt: "2026-11-05T00:00:00Z" },
  ];
  const prices = [{ id: "p1", cardId: "1", storeName: "x", surveyedOn: "2026-11-20", condition: "A", priceYen: 500 }, { id: "p2", cardId: "2", storeName: "x", surveyedOn: "2026-11-20", condition: "A", priceYen: 1500 }];
  it("価格降順: 高い順・記録なしは最後（昇順とは逆向き）。レアリティ順: 高い順（UR>SAR>R>未知>なし）。同じレアリティは新着順", () => {
    expect(sortMarketCards(cards, prices, "priceDesc", "2026-11-22").map((c) => c.id).slice(0, 2)).toEqual(["2", "1"]);
    expect(sortMarketCards(cards, prices, "priceAsc", "2026-11-22").map((c) => c.id).slice(0, 2)).toEqual(["1", "2"]);
    expect(sortMarketCards(cards, prices, "rarity", "2026-11-22").map((c) => c.id)).toEqual(["4", "2", "1", "5", "3"]);
    expect(rarityOrder("sar")).toBeLessThan(rarityOrder("R"));
  });
  it("通常タップの循環は指定の順序。長押しの一覧には全項目（図鑑No順を含む）", () => {
    expect(MARKET_SORT_ORDER).toEqual(["new", "priceDesc", "priceAsc", "condition", "rarity", "kana"]);
    let m = MARKET_SORT_ORDER[0];
    const seen = [m];
    for (let i = 0; i < 6; i++) seen.push((m = nextMarketSort(m)));
    expect(seen).toEqual(["new", "priceDesc", "priceAsc", "condition", "rarity", "kana", "new"]);
    expect(MARKET_SORT_MENU).toEqual([...MARKET_SORT_ORDER, "dex"]);
    expect(nextMarketSort("dex")).toBe("new"); // 一覧から図鑑No順を選んだ後のタップは、循環の先頭へ
    expect(marketSortHeading("priceDesc")).toBe("価格の高い順 ↓");
  });
});
