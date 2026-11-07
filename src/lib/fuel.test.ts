import { describe, expect, it } from "vitest";
import { calcFuelCost, DEFAULT_FUEL_KM_PER_L, DEFAULT_FUEL_PRICE_PER_L, fuelSettingsError } from "@/lib/fuel";

describe("ガソリン代の計算", () => {
  it("初期値は155円/Lと16.7km/L", () => {
    expect(DEFAULT_FUEL_PRICE_PER_L).toBe(155);
    expect(DEFAULT_FUEL_KM_PER_L).toBe(16.7);
  });
  it("往復は 片道×2÷燃費×単価（円に四捨五入）", () => {
    const r = calcFuelCost({ oneWayKm: 8.5, roundTrip: true, pricePerL: 155, kmPerL: 16.7 });
    // 17 / 16.7 * 155 = 157.78 → 158
    expect(r).toEqual({ ok: true, yen: 158 });
  });
  it("片道は 片道÷燃費×単価", () => {
    // 34 / 16.7 * 155 = 315.57 → 316
    expect(calcFuelCost({ oneWayKm: 34, roundTrip: false, pricePerL: 155, kmPerL: 16.7 })).toEqual({ ok: true, yen: 316 });
  });
  it("端数は四捨五入（x.5は切り上げ）", () => {
    // 10/10*155.5=155.5 → 156
    expect(calcFuelCost({ oneWayKm: 10, roundTrip: false, pricePerL: 155.5, kmPerL: 10 })).toEqual({ ok: true, yen: 156 });
    expect(calcFuelCost({ oneWayKm: 10, roundTrip: false, pricePerL: 154.4, kmPerL: 10 })).toEqual({ ok: true, yen: 154 });
  });
  it("燃費を変えると結果が変わる（再計算）", () => {
    const a = calcFuelCost({ oneWayKm: 12, roundTrip: true, pricePerL: 155, kmPerL: 16.7 });
    const b = calcFuelCost({ oneWayKm: 12, roundTrip: true, pricePerL: 155, kmPerL: 12 });
    expect(a.ok && b.ok && b.yen > a.yen).toBe(true);
  });
  it("文字列入力も受け付け、不正な値は理由を返す", () => {
    expect(calcFuelCost({ oneWayKm: "8.5", roundTrip: true, pricePerL: "155", kmPerL: "16.7" })).toEqual({ ok: true, yen: 158 });
    for (const bad of ["", "abc", "0", "-3"]) {
      const r = calcFuelCost({ oneWayKm: bad, roundTrip: true, pricePerL: 155, kmPerL: 16.7 });
      expect(r.ok).toBe(false);
    }
    expect(calcFuelCost({ oneWayKm: 5, roundTrip: true, pricePerL: 0, kmPerL: 16.7 }).ok).toBe(false);
    expect(calcFuelCost({ oneWayKm: 5, roundTrip: true, pricePerL: 155, kmPerL: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("燃費") });
  });
  it("設定値の検証", () => {
    expect(fuelSettingsError({ pricePerL: 155, kmPerL: 16.7 })).toBeNull();
    expect(fuelSettingsError({ pricePerL: 0, kmPerL: 16.7 })).not.toBeNull();
    expect(fuelSettingsError({ pricePerL: 155, kmPerL: 101 })).not.toBeNull();
  });
});
