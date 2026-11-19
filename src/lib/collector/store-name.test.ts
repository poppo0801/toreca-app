import { describe, expect, it } from "vitest";
import { looksLikeMultipleStores } from "./store-name";

describe("looksLikeMultipleStores（複数の店舗名が1つにまとまった名前）", () => {
  it("本番の店舗マスターで確認された、複数店舗をまとめた名前を検出する", () => {
    expect(looksLikeMultipleStores("渋谷店、浜松店")).toBe(true);
    expect(looksLikeMultipleStores("店舗・新星堂店舗・Ganryu店舗")).toBe(true);
    expect(looksLikeMultipleStores("トレカラウンジ秋葉原本店・トレカラウンジ別館買取センター")).toBe(true);
  });
  it("区切りがあるだけの1つの店名・通常の店名は対象にしない", () => {
    for (const n of ["ホビー・ランド 梅田店", "ブックオフ・スーパーバザー 梅田店", "天王寺店", "ライカ南国ホール", "応募時に店舗を選択", "通販", "", "A&B", "カードラボ なんば店"]) expect(looksLikeMultipleStores(n)).toBe(false);
    expect(looksLikeMultipleStores(null)).toBe(false);
  });
});
