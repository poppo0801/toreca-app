import { describe, expect, it } from "vitest";
import { conditionOptions, initialCondition, isAllowedCondition, normalizeGrade } from "@/lib/card-condition";

describe("Stage 6F-7: カードの状態（5段階）", () => {
  it("明確に対応づけられる表記だけ5段階へ変換する", () => {
    expect(normalizeGrade("B")).toBe("B");
    expect(normalizeGrade("b")).toBe("B");
    expect(normalizeGrade("Ａ＋")).toBe("A+");
    expect(normalizeGrade(" a+ ")).toBe("A+");
    expect(normalizeGrade("B plus")).toBe("B+");
  });
  it("美品・PSA10など対応づけられない値は変換しない（推測しない）", () => {
    for (const v of ["美品", "PSA10", "傷あり", "S", "D", ""]) expect(normalizeGrade(v)).toBeNull();
    expect(initialCondition("美品")).toBe("美品");
    expect(initialCondition("b")).toBe("B");
  });
  it("選択肢は未選択＋5段階。旧表記が残っていればその値も選べる", () => {
    expect(conditionOptions("").map((o) => o.value)).toEqual(["", "A+", "A", "B+", "B", "C"]);
    expect(conditionOptions("B").map((o) => o.value)).toEqual(["", "A+", "A", "B+", "B", "C"]);
    const legacy = conditionOptions("美品");
    expect(legacy.at(-1)).toMatchObject({ value: "美品" });
    expect(legacy).toHaveLength(7);
  });
  it("保存できるのは5段階・未選択・現在の旧表記のままの値だけ（自由入力は不可）", () => {
    expect(isAllowedCondition("")).toBe(true);
    expect(isAllowedCondition("A+")).toBe(true);
    expect(isAllowedCondition("美品")).toBe(false);
    expect(isAllowedCondition("美品", "美品")).toBe(true);
    expect(isAllowedCondition("新しい自由入力", "美品")).toBe(false);
  });
});
