import { describe, expect, it } from "vitest";
import { packForSetCode } from "@/lib/product-pack";

const products = [
  { officialName: "ステラミラクル", code: "SV7", archived: false },
  { officialName: "テラスタルフェスex", code: "SV8a", archived: false },
  { officialName: "重複A", code: "SV9", archived: false },
  { officialName: "重複B", code: "SV9", archived: false },
  { officialName: "旧弾", code: "SV1", archived: true },
];
describe("商品コードから収録パック", () => {
  it("一致する商品名を返す（表記ゆれを無視）", () => {
    expect(packForSetCode("sv8A", products)).toBe("テラスタルフェスex");
    expect(packForSetCode("ＳＶ７", products)).toBe("ステラミラクル");
  });
  it("なし・複数・アーカイブ済み・空は null", () => {
    expect(packForSetCode("SV99", products)).toBeNull();
    expect(packForSetCode("SV9", products)).toBeNull();
    expect(packForSetCode("SV1", products)).toBeNull();
    expect(packForSetCode("", products)).toBeNull();
  });
});
