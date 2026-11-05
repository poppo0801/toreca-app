import { describe, expect, it } from "vitest";
import { KANSAI3, KANSAI_KANTO6, matchRegion, presetSelection, regionMode, toggleRegion, validateRegion } from "@/lib/region-filter";

const present = ["兵庫県", "大阪府", "京都府", "東京都", "北海道"];

describe("Stage 6E-5: 地域フィルターの共通仕様", () => {
  it("プリセットの内容", () => {
    expect(KANSAI3).toEqual(["兵庫県", "大阪府", "京都府"]);
    expect(KANSAI_KANTO6).toEqual(["兵庫県", "大阪府", "京都府", "東京都", "神奈川県", "千葉県"]);
    expect(presetSelection("all")).toEqual([]);
  });
  it("モードは、データに存在する都道府県だけで判定する（神奈川・千葉が無くても『関西＋関東6都府県』になる）", () => {
    expect(regionMode([...KANSAI3], present)).toBe("kansai3");
    expect(regionMode([...KANSAI_KANTO6], present)).toBe("kanto6");
    expect(regionMode([], present)).toBe("all");
    expect(regionMode(["大阪府"], present)).toBe("custom");
    expect(regionMode(["東京都", "北海道"], present)).toBe("custom");
  });
  it("存在しない都道府県が無ければ、関西3県のプリセットは3県の一部でも成立する", () => {
    expect(regionMode([...KANSAI3], ["兵庫県", "大阪府"])).toBe("kansai3");
  });
  it("個別の切替: 外す→カスタム、すべて選ぶと『すべて』（空）に戻る", () => {
    expect(toggleRegion([...KANSAI3], "京都府", present)).toEqual(["兵庫県", "大阪府"]);
    expect(toggleRegion([], "北海道", present)).toEqual(["兵庫県", "大阪府", "京都府", "東京都"]);
    expect(toggleRegion(["兵庫県", "大阪府", "京都府", "東京都"], "北海道", present)).toEqual([]);
  });
  it("通販・発送のみ・所在地不明は、地域では除外しない", () => {
    expect(matchRegion([...KANSAI3], "東京都", false)).toBe(false);
    expect(matchRegion([...KANSAI3], "東京都", true)).toBe(true); // 通販
    expect(matchRegion([...KANSAI3], "", false)).toBe(true); // 所在地不明
    expect(matchRegion([...KANSAI3], undefined, false)).toBe(true);
    expect(matchRegion([...KANSAI3], "大阪府", false)).toBe(true);
    expect(matchRegion([], "東京都", false)).toBe(true); // すべて
  });
  it("保存値の検証", () => {
    expect(validateRegion(["大阪府"])).toEqual(["大阪府"]);
    expect(validateRegion("大阪府")).toBeNull();
    expect(validateRegion([1])).toBeNull();
  });
});
