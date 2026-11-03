import { describe, expect, it } from "vitest";
import { classifyAxis, commitDirection, pullOffset, SWIPE } from "@/lib/swipe";

describe("スワイプの軸判定（縦スクロールを横スワイプと誤判定しない）", () => {
  it("動きが小さい間は未確定（タップ・スクロール開始を妨げない）", () => {
    expect(classifyAxis(0, 0)).toBe("pending");
    expect(classifyAxis(9, 3)).toBe("pending");
    expect(classifyAxis(-4, 9)).toBe("pending");
  });
  it("縦に大きく動けば縦（スワイプではない）", () => {
    expect(classifyAxis(2, 24)).toBe("vertical");
    expect(classifyAxis(14, 14)).toBe("vertical"); // 斜めは縦スクロール扱い
    expect(classifyAxis(20, 16)).toBe("vertical"); // 横がやや優勢でも倍率に届かなければ縦
  });
  it("横が縦の1.8倍以上のときだけ横", () => {
    expect(classifyAxis(36, 10)).toBe("horizontal");
    expect(classifyAxis(-40, 8)).toBe("horizontal");
    expect(classifyAxis(18, 10)).toBe("horizontal");
    expect(classifyAxis(17, 10)).toBe("vertical");
  });
  it("縦スクロール中に少し横へぶれても、軸は最初の判定のまま使う前提で、横判定には縦の倍率が必要", () => {
    // 指を縦に20px動かした後の dx=30 は、縦移動の1.8倍(=36)に届かないので横にならない
    expect(classifyAxis(30, 20)).toBe("vertical");
  });
});

describe("スワイプの確定", () => {
  it("移動量が足りなければ元に戻す", () => {
    expect(commitDirection(40, 360)).toBeNull();
    expect(commitDirection(-60, 360)).toBeNull();
  });
  it("閾値以上で方向を返す（右=正、左=負）", () => {
    expect(commitDirection(SWIPE.COMMIT_PX, 360)).toBe("right");
    expect(commitDirection(-SWIPE.COMMIT_PX - 5, 360)).toBe("left");
  });
  it("幅の狭いカードでは幅の比率に応じて閾値が下がる（最低48px）", () => {
    expect(commitDirection(55, 200)).toBe("right"); // 200*0.25=50
    expect(commitDirection(47, 100)).toBeNull();
    expect(commitDirection(49, 100)).toBe("right");
  });
});

describe("カードの追従量", () => {
  it("閾値までは指に追従し、それ以降は重く、上限を超えない", () => {
    expect(pullOffset(30)).toBe(30);
    expect(pullOffset(SWIPE.COMMIT_PX)).toBe(SWIPE.COMMIT_PX);
    expect(pullOffset(SWIPE.COMMIT_PX + 100)).toBeLessThan(SWIPE.COMMIT_PX + 100);
    expect(pullOffset(1000)).toBe(SWIPE.MAX_PULL_PX);
    expect(pullOffset(-1000)).toBe(-SWIPE.MAX_PULL_PX);
  });
});
