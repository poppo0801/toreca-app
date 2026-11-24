// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cautionSummary, normalizeCautions } from "./attention";

describe("注意のDB読み込み（境界の検証）", () => {
  it("message が無い古い行でも、要約が落ちない（描画クラッシュの再発防止）。注意は消さず既定の文言で残る", () => {
    const rows = normalizeCautions([{ code: "deadline_unknown", field: "applyDeadline" }, { code: "x", message: "締切が未確認（詳細）" }]);
    expect(rows).toHaveLength(2);
    expect(() => cautionSummary(rows)).not.toThrow();
    expect(cautionSummary(rows)).toContain("確認が必要");
    expect(cautionSummary(rows)).toContain("締切が未確認");
  });
  it("配列でない・コードの無い要素・null は捨てる。ackAt などの既存の項目は保持する", () => {
    expect(normalizeCautions(null)).toEqual([]);
    expect(normalizeCautions({ code: "a" })).toEqual([]);
    expect(normalizeCautions([null, 1, "s", { message: "m" }])).toEqual([]);
    expect(normalizeCautions([{ code: "a", message: "m", field: "other", ackAt: "2026-11-24T00:00:00Z" }])[0]).toMatchObject({ ackAt: "2026-11-24T00:00:00Z", message: "m" });
  });
});
