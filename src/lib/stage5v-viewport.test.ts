import { describe, expect, it } from "vitest";
import { isTouchingNow, stabilizeShift, TOUCH_STALE_MS } from "@/lib/viewport-insets";

describe("触れている状態の有効期間（下部メニューが途切れたまま固定される原因の対処）", () => {
  it("最後のタッチイベントから一定時間を過ぎたら、touchendを取りこぼしていても離れたものとして扱う", () => {
    expect(isTouchingNow(true, 1000, 1000 + TOUCH_STALE_MS - 1)).toBe(true);
    expect(isTouchingNow(true, 1000, 1000 + TOUCH_STALE_MS)).toBe(false);
    expect(isTouchingNow(false, 1000, 1001)).toBe(false);
  });
  it("触れたままの扱いが残ると補正値が更新されないが、期間を過ぎれば、ずれたまま残った値を採用できる", () => {
    let s = { raw: 0, same: 0, applied: 0 };
    // 取りこぼし: 触れている扱いのままだと、何フレーム経っても採用されない
    for (let i = 0; i < 30; i++) s = stabilizeShift(s, 40, true);
    expect(s.applied).toBe(0);
    // 期間を過ぎて触れていない扱いになれば、同じ値が続いた時点で採用される
    for (let i = 0; i < 12; i++) s = stabilizeShift(s, 40, isTouchingNow(true, 0, 5000));
    expect(s.applied).toBe(40);
    // 0に戻れば即座に戻る（補正が残り続けない）
    s = stabilizeShift(s, 0, false);
    expect(s.applied).toBe(0);
  });
});
