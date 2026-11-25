// @vitest-environment node
import { describe, expect, it } from "vitest";
import { deadlineTimeTokens, parseTimes, timeTokens } from "./time-tokens";

describe("時刻の読み取り（不正・曖昧な表記を補正しない）", () => {
  it("24:00 だけ許可（翌日0時）。24:01〜24:59・25時・60分は不正として捨てる（補正しない）", () => {
    expect(timeTokens("24:00")).toEqual(["24:00"]);
    expect(timeTokens("24時")).toEqual(["24:00"]);
    for (const bad of ["24:01", "24:59", "25:00", "23:60", "99:99", "25時", "23時60分"]) {
      const r = parseTimes(bad);
      expect(r.valid, bad).toEqual([]);
      expect(r.invalid.length, bad).toBeGreaterThan(0);
    }
  });
  it("12時間制: 午前/午後は0〜11時。午後13時・午前13時は不正。午前12時・午後12時は意味が割れるため採用しない。午前0時=00:00・午後0時=12:00", () => {
    expect(timeTokens("午前0時")).toEqual(["00:00"]);
    expect(timeTokens("午後0時")).toEqual(["12:00"]);
    expect(timeTokens("午後11時59分")).toEqual(["23:59"]);
    expect(timeTokens("午前9:30")).toEqual(["09:30"]);
    for (const bad of ["午後13時", "午前13時", "午後12時", "午前12時", "午後11時60分"]) {
      expect(parseTimes(bad).valid, bad).toEqual([]);
      expect(parseTimes(bad).invalid.length, bad).toBeGreaterThan(0);
    }
  });
  it("英字 AM/PM: 12:00 AM=00:00・12:00 PM=12:00。13 PM や 0 AM は不正", () => {
    expect(timeTokens("12:00 AM")).toEqual(["00:00"]);
    expect(timeTokens("12:00 PM")).toEqual(["12:00"]);
    expect(timeTokens("11:59 PM")).toEqual(["23:59"]);
    expect(timeTokens("PM 11:59")).toEqual(["23:59"]);
    expect(parseTimes("13:00 PM").valid).toEqual([]);
    expect(parseTimes("0:30 AM").valid).toEqual([]);
  });
  it("全角・「23時」「23時59分」・「10時間」は時刻にしない", () => {
    expect(timeTokens("２３：５９")).toEqual(["23:59"]);
    expect(timeTokens("23時")).toEqual(["23:00"]);
    expect(timeTokens("23時59分")).toEqual(["23:59"]);
    expect(timeTokens("約10時間")).toEqual([]);
  });
  it("応募締切の文脈の時刻だけを取り、受付時間・当選発表・営業時間の時刻は取り違えない", () => {
    expect(deadlineTimeTokens("応募締切 11月30日 23:59まで")).toEqual(["23:59"]);
    expect(deadlineTimeTokens("受付時間 10:00〜20:00")).toEqual([]);
    expect(deadlineTimeTokens("応募締切 11/30 23:59 当選発表 12/1 12:00")).toEqual(["23:59"]);
    expect(deadlineTimeTokens("当選発表 12/1 12:00 応募締切 11/30 23:59")).toEqual(["23:59"]);
    expect(deadlineTimeTokens("店舗の営業時間 10:00〜20:00。応募期間は11月30日まで")).toEqual([]);
    expect(deadlineTimeTokens("エントリーは11/30 18時まで")).toEqual(["18:00"]);
  });
});
