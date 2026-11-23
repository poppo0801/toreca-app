// @vitest-environment node
/** 相場調査メモ: カード一覧の五十音順・図鑑No順（ポケモンの読み仮名・全国図鑑番号。カード名の「ex」等・カードの収録番号の影響を受けない）。 */
import { describe, expect, it } from "vitest";
import { marketSortHeading, MARKET_SORT_ORDER, sortMarketCards, type DexOf } from "./zukan";
import { matchPokemonByCardName } from "./pokemon-match";
import { pokemonMaster } from "./pokemon-match";

interface C {
  id: string;
  name: string;
  setName: string;
  cardNumber: string;
  createdAt: string;
}
const card = (id: string, name: string, cardNumber = "001/100", setName = "S", createdAt = "2026-11-01T00:00:00Z"): C => ({ id, name, setName, cardNumber, createdAt });
const dexOf: DexOf<C> = (c) => {
  const p = matchPokemonByCardName(c.name);
  const m = p ? pokemonMaster(p.no) : null;
  return m ? { no: m.no, reading: m.reading } : null;
};
const cards = [
  card("1", "ピカチュウex", "132/165", "151"),
  card("2", "リザードン", "006/078", "S2"),
  card("3", "ハイパーボール", "100/100", "S", "2026-11-10T00:00:00Z"),
  card("4", "ミュウツー", "150/150"),
  card("5", "ミュウex", "151/151"),
  card("6", "フシギダネ", "001/165"),
  card("7", "ピカチュウV", "004/100", "S3"),
  card("8", "ミュウツーとミュウ", "009/009", "S", "2026-11-12T00:00:00Z"),
  card("9", "アーボ", "023/165"),
  card("10", "ニドラン♀", "029/165"),
];
const names = (m: "kana" | "dex", input = cards) => sortMarketCards(input, [], m, "2026-11-22", dexOf).map((c) => c.name);

describe("カード一覧の並び替え: 図鑑No順・五十音順", () => {
  it("図鑑No順: 全国図鑑番号の昇順。特定できないカード（トレーナーズ・複数のポケモン）は末尾（新着順）。同じポケモンの複数カードは安定した順序", () => {
    const r = names("dex");
    expect(r.slice(0, 8)).toEqual(["フシギダネ", "リザードン", "アーボ", expect.stringMatching(/^ピカチュウ/), expect.stringMatching(/^ピカチュウ/), "ニドラン♀", "ミュウツー", "ミュウex"]);
    expect(r.slice(8)).toEqual(["ミュウツーとミュウ", "ハイパーボール"]); // 番号なし=末尾。新着順（11/12 → 11/10）
  });
  it("五十音順: ポケモンの読み仮名（カード名の ex・V には影響されない）。♀♂は読みから除く。ミュウ < ミュウツー", () => {
    const r = names("kana");
    expect(r.slice(0, 8)).toEqual(["アーボ", "ニドラン♀", expect.stringMatching(/^ピカチュウ/), expect.stringMatching(/^ピカチュウ/), "フシギダネ", "ミュウex", "ミュウツー", "リザードン"]);
    expect(r.slice(8)).toEqual(["ミュウツーとミュウ", "ハイパーボール"]);
  });
  it("入力順が変わっても同じ並び（安定）。同じポケモンの複数カードは カード名→セット→カード番号→ID", () => {
    for (const m of ["kana", "dex"] as const) expect(names(m, [...cards].reverse())).toEqual(names(m));
    const pika = sortMarketCards([card("a", "ピカチュウ", "002/100", "S"), card("b", "ピカチュウ", "001/100", "S"), card("c", "ピカチュウ", "001/100", "A")], [], "dex", "2026-11-22", dexOf);
    expect(pika.map((c) => c.id)).toEqual(["c", "b", "a"]); // セット A < S、同セットは番号の昇順
  });
  it("図鑑番号とカードの収録番号は別: カード番号の大小は並びに影響しない", () => {
    const r = sortMarketCards([card("x", "ミュウ", "001/151"), card("y", "フシギダネ", "999/999")], [], "dex", "2026-11-22", dexOf);
    expect(r.map((c) => c.name)).toEqual(["フシギダネ", "ミュウ"]); // フシギダネ(No.1) が先（収録番号は 999 でも）
  });
  it("見出しの表示: 並び順と向き。全モードが循環に含まれる", () => {
    expect(MARKET_SORT_ORDER).toEqual(["new", "dex", "priceDesc", "priceAsc", "condition", "rarity", "kana"]);
    expect(marketSortHeading("priceAsc")).toBe("価格の安い順 ↑");
    expect(marketSortHeading("kana")).toBe("五十音順 ↑");
    expect(marketSortHeading("dex")).toBe("図鑑No順 ↑");
    expect(marketSortHeading("new")).toBe("新着順 ↓");
  });
  it("既存の並び（価格の安い順・状態優先・新着順）は維持される（dexOf 無しでも動く）", () => {
    const prices = [
      { id: "p1", cardId: "1", storeName: "s", surveyedOn: "2026-11-20", condition: "C", priceYen: 900 },
      { id: "p2", cardId: "2", storeName: "s", surveyedOn: "2026-11-20", condition: "S", priceYen: 1500 },
    ];
    expect(sortMarketCards(cards.slice(0, 2), prices, "priceAsc", "2026-11-22").map((c) => c.id)).toEqual(["1", "2"]);
    expect(sortMarketCards(cards.slice(0, 2), prices, "condition", "2026-11-22").map((c) => c.id)).toEqual(["2", "1"]);
  });
});

describe("図鑑番号の誤判定が無い（カード名 → ポケモン）", () => {
  it("名前が似た別ポケモン・複数のポケモン・種別表記だけ違うカードを正しく扱う", () => {
    expect(matchPokemonByCardName("ミュウex")?.no).toBe(151);
    expect(matchPokemonByCardName("ミュウツーex")?.no).toBe(150);
    expect(matchPokemonByCardName("ミュウツーとミュウ")).toBeNull();
    expect(matchPokemonByCardName("リザードンex")?.no).toBe(6);
    expect(matchPokemonByCardName("リザード")?.no).toBe(5); // リザードン(6) と取り違えない
    expect(matchPokemonByCardName("ゴース")?.no).toBe(92);
    expect(matchPokemonByCardName("ゴースト")?.no).toBe(93);
    expect(matchPokemonByCardName("ポケモンカード」" )).toBeNull();
  });
  it("マスター: 番号・正式名称・読み仮名", () => {
    expect(pokemonMaster(25)).toEqual({ no: 25, name: "ピカチュウ", reading: "ピカチュウ" });
    expect(pokemonMaster(29)).toEqual({ no: 29, name: "ニドラン♀", reading: "ニドラン" });
    expect(pokemonMaster(0)).toBeNull();
    expect(pokemonMaster(1026)).toBeNull();
  });
});
