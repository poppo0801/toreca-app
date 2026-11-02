import { describe, expect, it } from "vitest";
import { matchChain, matchProduct, productKey } from "@/lib/lottery-match";

describe("Stage 4C 最終調整: 名称の正規化", () => {
  it("商品名の表記ゆれ（記号・パック種別・MEGA接頭辞）を同一視する", () => {
    expect(productKey("MEGA拡張パック「アビスアイ」")).toBe(productKey("アビスアイ"));
    expect(productKey("ハイクラスパック『テラスタルフェスex』")).toBe(productKey("テラスタルフェスex"));
  });
  it("別商品は同一視しない", () => {
    expect(productKey("アビスアイ")).not.toBe(productKey("ブラックボルト"));
  });
  it("チェーンの表記ゆれ（ブックオフ/BOOKOFF）を一致させる", () => {
    const chains = [{ id: "c1", name: "BOOKOFF", aliases: [], archived: false }] as never;
    expect(["exact", "alias"]).toContain(matchChain("ブックオフ", chains).kind);
  });
  it("未登録の商品は none（既存商品に誤って寄せない）", () => {
    const products = [{ id: "p1", officialName: "アビスアイ", code: "", aliases: [], archived: false }] as never;
    expect(matchProduct("まったく別の新弾", "", products).kind).toBe("none");
  });
});
