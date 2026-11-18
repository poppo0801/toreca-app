import { describe, expect, it } from "vitest";
import { isSoleShopName } from "./sole-store";

describe("単独の通販ショップを店舗名だけに分類しない（9H-3M）", () => {
  it("通販のみで支店を示す語が無い単独ショップは、系列名として扱う（トレカ ラビットバーン）", () => {
    expect(isSoleShopName("トレカ ラビットバーン", "shipping")).toBe(true);
  });
  it("店舗受取・どちらも可・不明のときは変えない", () => {
    for (const r of ["store", "either", "unknown", null, undefined]) expect(isSoleShopName("トレカ ラビットバーン", r)).toBe(false);
  });
  it("支店名（〜店）・一般語（オンライン・通販）・店舗選択式は対象にしない", () => {
    for (const s of ["姫路店", "なんば店", "オンライン", "通販", "公式サイト", "店舗選択式（選べる店舗: 不明）", "全国のゲオ店舗"]) expect(isSoleShopName(s, "shipping")).toBe(false);
  });
});
