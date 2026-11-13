// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GOLD_KEYS, score, summarize, worldOf, type Label, type Scenario } from "@/lib/agent/lottery-grouping/eval-world";
import { MockGroupingBrain, type BrainPolicy } from "@/lib/agent/lottery-grouping/mock";
import { evaluateGrouping } from "@/lib/agent/lottery-grouping/run";

/**
 * Stage 8F-6: 抽選形態（店舗選択式／店舗別独立）の評価（架空11シナリオ。モックAI × 検証層。実APIではない）。
 * 入力（scenarios-8f6.json）と正解（gold-8f6.json）は別ファイル。8F-5 までの40件（scenarios.json）は変更していない。
 */
const scenarios = JSON.parse(readFileSync("eval/lottery-grouping/scenarios-8f6.json", "utf8")).scenarios as Scenario[];
const gold = JSON.parse(readFileSync("eval/lottery-grouping/gold-8f6.json", "utf8")).labels as Record<string, { label: Label; why: string }>;

describe("抽選形態の評価（8F-6・架空11シナリオ）", () => {
  it("入力に正解が混ざっていない。入力と正解のIDが一致する", () => {
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { expect(GOLD_KEYS).not.toContain(k); walk(x); }
    };
    walk(scenarios);
    expect(scenarios.map((s) => s.id).sort()).toEqual(Object.keys(gold).sort());
  });
  it("全方針: 誤って自動でまとめた件数は0。店舗選択式・条件/期間/商品の違いは、まとめない", async () => {
    for (const policy of ["careful", "eager", "liar", "lazy", "timid"] as BrainPolicy[]) {
      const rows = [];
      for (const sc of scenarios) {
        const o = await evaluateGrouping(worldOf(sc), { llm: new MockGroupingBrain(policy), allowAuto: true, followUps: 0 });
        rows.push({ id: sc.id, s: score(gold[sc.id].label, o), tier: o.decision.tier });
      }
      expect(rows.filter((r) => r.s.autoHarm).map((r) => r.id), policy).toEqual([]);
      if (policy === "careful") {
        const sum = summarize(rows.map((r) => ({ id: r.id, title: "", label: gold[r.id].label, s: r.s, tier: r.tier, confidence: 0, reason: "" })));
        expect(sum.precisionAuto).toBe(1);
        // 店舗選択式（H02・H03）は、どの方針でも、まとめない（single）
        for (const id of ["H02", "H03"]) expect(rows.find((r) => r.id === id)!.tier, id).toBe("single");
        // 構造のある店舗別独立抽選は自動（H01・H05）。制限だけ・情報不足・略称は、自動にしない
        for (const id of ["H01", "H05"]) expect(rows.find((r) => r.id === id)!.tier, id).toBe("auto");
        for (const id of ["H04", "H08", "H10"]) expect(rows.find((r) => r.id === id)!.tier, id).not.toBe("auto");
      }
    }
  });
});
