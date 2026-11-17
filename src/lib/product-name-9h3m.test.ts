import { describe, expect, it } from "vitest";
import { tidyProductName } from "./product-name";

// 9H-3K の人間評価の案件（ヨドバシ・ゲオ・販売サイト表記・数量表記）。商品名には、正式な名称だけを残す
describe("商品名の整理: 販売サイト表記・重複・数量表記の混入を防ぐ（9H-3M）", () => {
  it("重なるブランド名の接頭辞（ポケモン Pokemon ポケモンカードゲーム）をまとめて除く", () => {
    expect(tidyProductName("ポケモン Pokemon ポケモンカードゲーム MEGA 拡張パック ハドウシーカー")).toBe("ハドウシーカー");
  });
  it("同じ名称の繰り返しと、途中のブランド名だけの語（ポケカ）を除く（ゲオ）", () => {
    expect(tidyProductName("スペシャルデッキセットMEGA メガオーダイル・メガカイリュー・メガゲンガー ポケカ スペシャルデッキセットMEGA")).toBe("スペシャルデッキセットMEGA メガオーダイル・メガカイリュー・メガゲンガー");
  });
  it("販売サイトの表記（末尾の｜ヨドバシ.com・先頭の【Yahoo!ショッピング】）を除く", () => {
    expect(tidyProductName("ポケモンカードゲーム 拡張パック ハドウシーカー｜ヨドバシ.com")).toBe("ハドウシーカー");
    expect(tidyProductName("【Yahoo!ショッピング】スペシャルデッキセットMEGA")).toBe("スペシャルデッキセットMEGA");
  });
  it("数量・入数の表記（1BOX・30パック入）は商品名に含めない", () => {
    expect(tidyProductName("拡張パック ハドウシーカー 1BOX（30パック入）")).toBe("ハドウシーカー");
  });
  it("商品を区別する語は残す（特別版・スペシャル・セット・30th CELEBRATION）", () => {
    expect(tidyProductName("30th CELEBRATION カードセット 9種セット")).toContain("30th CELEBRATION");
    expect(tidyProductName("スペシャルデッキセットMEGA")).toBe("スペシャルデッキセットMEGA");
  });
  it("ポケモンセンター等、ブランド語で始まる別の名称は壊さない", () => {
    expect(tidyProductName("ポケモンセンター限定 ピカチュウ")).toContain("ポケモンセンター");
  });
});
