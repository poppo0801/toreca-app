// supabase db query の出力形式の違い（表形式・素の配列・{rows}）を扱えること。定期バックアップ失敗（2026-11）の再発防止。
import { describe, expect, it } from "vitest";
// @ts-expect-error .mjs（型なし）
import { parseQueryRows } from "../scripts/lib/query-output.mjs";

describe("parseQueryRows", () => {
  it("素の配列（--output-format json）を受ける", () => {
    expect(parseQueryRows('[\n  {\n    "t": "a",\n    "n": 3\n  }\n]\n')).toEqual([{ t: "a", n: 3 }]);
  });
  it("{rows:[...]} 形式（エージェント検出時）を受ける", () => {
    expect(parseQueryRows('{"rows":[{"x":1}],"rowCount":1}')).toEqual([{ x: 1 }]);
  });
  it("前後に警告が混ざっても取り出せる", () => {
    expect(parseQueryRows('warn\n[{"x":1}]\n')).toEqual([{ x: 1 }]);
  });
  it("表形式の出力は、原因が分かる明確なエラーにする（JSON.parse の謎のエラーにしない）", () => {
    expect(() => parseQueryRows("┌───┐\n│ x │\n├───┤\n│ 1 │\n└───┘\n")).toThrow(/表形式/);
  });
  it("空の応答はエラー", () => {
    expect(() => parseQueryRows("")).toThrow(/空/);
  });
});
