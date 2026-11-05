import { describe, expect, it } from "vitest";
import { fitFontSize, FIT_MIN_PX } from "@/components/fit-line";

describe("日付行の文字サイズ調整（5Z）", () => {
  it("収まるなら縮小しない", () => {
    expect(fitFontSize(100, 120, 12)).toBe(12);
    expect(fitFontSize(120, 120, 12)).toBe(12);
  });
  it("収まらないときは、必要幅との比率で行全体を縮小する", () => {
    expect(fitFontSize(150, 100, 12)).toBe(9); // 12 × 2/3 = 8 → 下限 9
    expect(fitFontSize(120, 100, 12)).toBe(10);
  });
  it("読めなくなる下限より小さくしない", () => {
    expect(fitFontSize(1000, 100, 12)).toBe(FIT_MIN_PX);
  });
  it("幅が測れない（0）ときは変更しない", () => {
    expect(fitFontSize(100, 0, 12)).toBe(12);
  });
});
