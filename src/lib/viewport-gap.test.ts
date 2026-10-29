import { describe, expect, it } from "vitest";
import { viewportGap } from "@/lib/viewport-gap";

describe("起動直後の表示領域のずれの補正量", () => {
  it("実機の診断値（100vh=852 / innerHeight=793 / standalone）は 59px", () => {
    expect(viewportGap(852, 793, true)).toBe(59);
  });
  it("ずれが無ければ0。Safari のタブ（standalone でない）では補正しない", () => {
    expect(viewportGap(852, 852, true)).toBe(0);
    expect(viewportGap(852, 793, false)).toBe(0);
  });
  it("極端な差（開発者ツールなど）や逆転は補正しない", () => {
    expect(viewportGap(1000, 700, true)).toBe(0);
    expect(viewportGap(700, 852, true)).toBe(0);
  });
});
