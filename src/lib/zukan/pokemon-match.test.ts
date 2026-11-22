// @vitest-environment node
/** カード名 → ポケモンの照合（相場調査メモの画像表示用）。全ポケモン対応・誤画像を出さない。 */
import { describe, expect, it } from "vitest";
import { ALL_POKEMON_NAMES } from "./pokemon-names";
import { POKEMON_151 } from "./pokemon151";
import { matchPokemonByCardName as m } from "./pokemon-match";

describe("全ポケモンの名称データ", () => {
  it("全国図鑑No.1〜1025が揃い、重複・空が無い。先頭151は図鑑マスターの名称と一致する", () => {
    expect(ALL_POKEMON_NAMES).toHaveLength(1025);
    expect(ALL_POKEMON_NAMES.every((n) => n.length > 0)).toBe(true);
    expect(new Set(ALL_POKEMON_NAMES).size).toBe(1025);
    expect(POKEMON_151.every((p) => ALL_POKEMON_NAMES[p.no - 1] === p.name)).toBe(true);
  });
});

describe("カード名からの照合", () => {
  it("実機で画像が出なかった現行カード名（151以外を含む）を、正しい番号に対応づける", () => {
    const expected: Record<string, number> = { ミロカロス: 350, デデンネ: 702, バチュル: 595, ブルンゲルex: 593, ピィ: 173, ドリュウズex: 530, コドラ: 305, メテノ: 774, メレシー: 703, オドリドリex: 741 };
    for (const [card, no] of Object.entries(expected)) {
      const r = m(card);
      expect(r?.no, card).toBe(no);
      expect(ALL_POKEMON_NAMES[no - 1]).toBe(card.replace(/ex$/, ""));
    }
  });
  it("種別表記（ex・V・VMAX・VSTAR・GX・☆・括弧書き・空白）を除いて照合する", () => {
    for (const c of ["ピカチュウ ex", "ピカチュウV", "ピカチュウVMAX", "ピカチュウVSTAR", "ピカチュウGX", "ピカチュウ☆", "ピカチュウ（ふしぎ）", "【プロモ】ピカチュウ", "ピカチュウ　EX"]) expect(m(c)?.no, c).toBe(25);
  });
  it("許可した接頭（メガ・地方・かがやく等）と「〇〇の」+ ポケモン名", () => {
    expect(m("メガリザードンex")?.no).toBe(6);
    expect(m("アローラ ライチュウ")?.no).toBe(26);
    expect(m("かがやくリザードン")?.no).toBe(6);
    expect(m("ロケット団のミュウツー")?.no).toBe(150);
    expect(m("ホップのザシアン")?.name).toBe("ザシアン");
  });
  it("誤った画像を出さない: トレーナーズ・エネルギー・グッズ・複数のポケモン・名前を含むだけの語は null（プレースホルダー）", () => {
    for (const c of ["ハイパーボール", "博士の研究", "ミュウツーとミュウ", "ピカチュウ&ゼクロムGX", "リーリエのピッピ人形", "基本草エネルギー", "ポケモンのどうぐ", "ピカチュウのしっぽ", "", "ex"]) expect(m(c), c).toBeNull();
  });
  it("ミュウとミュウツーは取り違えない（完全一致）。ニドラン♀/♂も区別する", () => {
    expect(m("ミュウ")?.no).toBe(151);
    expect(m("ミュウツー")?.no).toBe(150);
    expect(m("ニドラン♀")?.no).toBe(29);
    expect(m("ニドラン♂")?.no).toBe(32);
  });
});
