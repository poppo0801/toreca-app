import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { trialItems } from "./proposal-job";

describe("実行台帳の試行の要約（INTENSIVE_EVALUATION §1）", () => {
  const rec = (o: Partial<Parameters<typeof trialItems>[0][number]> = {}) => ({ proposalKey: "k".repeat(24), decision: "tentative", verified: true, inputHash: "h".repeat(16), judgeTrail: [{ stage: "primary", model: "claude-haiku-5-5", reason: null, decision: "tentative", verified: true }, { stage: "escalated", model: "claude-sonnet-5-5", reason: "material_unknown", decision: "exclude", verified: true, adopted: true }], pages: [{ host: "example.jp" }], costJpy: 4.12345, turns: 3, endReason: "sufficient", fields: { store: { basis: "observed", value: "店" }, product: { basis: "unknown", value: null }, _rationale: { basis: "inferred", value: "x" } }, ...o });
  it("判断・段（採用を含む）・入力ハッシュ・費用・観察した項目名を残し、原文・値は残さない", () => {
    const [t] = trialItems([rec()]);
    expect(t).toMatchObject({ d: "tentative", v: true, ih: "hhhhhhhhhhhh", c: 4.123, n: 3, e: "sufficient", o: ["store"], p: ["example.jp"] });
    expect(t.t[1]).toEqual({ s: "escalated", m: "sonnet-5-5", r: "material_unknown", d: "exclude", v: true, a: true });
    expect(JSON.stringify(t)).not.toContain("店");
  });
  it("項目は最大6件・段は最大3件（実行台帳の行の大きさに収める）", () => {
    const xs = trialItems(Array.from({ length: 9 }, () => rec()));
    expect(xs).toHaveLength(6);
    expect(JSON.stringify(xs).length).toBeLessThan(7000);
  });
});

describe("台帳の試行の要約の優先（PRODUCTION_PARITY）", () => {
  it("7件目以降の失敗・未検証も、先頭の暫定より優先して残す", () => {
    const base = { proposalKey: "k".repeat(24), inputHash: "h".repeat(16), pages: [], costJpy: 0, turns: 1, endReason: "x", fields: {} };
    const recs = [...Array.from({ length: 7 }, () => ({ ...base, decision: "tentative", verified: true })), { ...base, decision: "none", verified: false }];
    const t = trialItems(recs as never);
    expect(t).toHaveLength(6);
    expect(t.some((x) => x.d === "none")).toBe(true);
  });
});
