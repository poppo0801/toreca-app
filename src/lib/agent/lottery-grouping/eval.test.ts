// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GOLD_KEYS, score, summarize, worldOf, type Label, type Scenario, type Score, type Summary } from "@/lib/agent/lottery-grouping/eval-world";
import { MockGroupingBrain, type BrainPolicy } from "@/lib/agent/lottery-grouping/mock";
import { evaluateGrouping } from "@/lib/agent/lottery-grouping/run";

/**
 * 抽選グループ判定の精度評価（Stage 8F）。モックAI × 検証層 を、40の架空シナリオと正解ラベルで採点する。
 * 実際のAI（実API）の判断力の評価ではない。評価できるのは「検証層が、AIの提出（過剰なもの・嘘のものを含む）を、誤ってまとめない形に直せるか」と
 * 「慎重なAIの提出を、取りこぼさず自動・候補にできるか」。実APIでの精度は、費用と条件を報告して承認を得たあとに別途測る。
 *   npm run eval:grouping   → eval/runs/lottery-grouping-report.md
 */
const scenarios = JSON.parse(readFileSync("eval/lottery-grouping/scenarios.json", "utf8")).scenarios as Scenario[];
const gold = JSON.parse(readFileSync("eval/lottery-grouping/gold.json", "utf8")).labels as Record<string, { label: Label; why: string }>;

interface Row { id: string; title: string; label: Label; s: Score; tier: string; confidence: number; reason: string }
async function run(policy: BrainPolicy, followUps = 0): Promise<{ rows: Row[]; sum: Summary }> {
  const rows: Row[] = [];
  for (const sc of scenarios) {
    const o = await evaluateGrouping(worldOf(sc), { llm: new MockGroupingBrain(policy), allowAuto: true, followUps });
    const s = score(gold[sc.id].label, o);
    rows.push({ id: sc.id, title: sc.title, label: gold[sc.id].label, s, tier: o.decision.skipReason ? `${o.decision.tier}(記録済み)` : o.decision.tier, confidence: o.decision.confidence, reason: o.decision.rationale.split(" / ").at(-1)?.slice(0, 70) ?? "" });
  }
  return { rows, sum: summarize(rows) };
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const runs: { name: string; res: Awaited<ReturnType<typeof run>> }[] = [];

describe("抽選グループ判定の評価（モックAI × 検証層）", () => {
  it("入力に正解が混ざっていない。入力と正解のIDが一致する", () => {
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { expect(GOLD_KEYS, `${path}.${k}`).not.toContain(k); walk(x, `${path}.${k}`); }
    };
    walk(scenarios, "scenarios");
    expect(scenarios.map((s) => s.id).sort()).toEqual(Object.keys(gold).sort());
    expect(scenarios.length).toBe(40);
  });

  it("全方針: 誤って自動でまとめた件数は0（最重要）。過剰なAI・嘘をつくAIでも、検証層が止める", async () => {
    for (const [policy, f] of [["careful", 0], ["eager", 0], ["liar", 0], ["lazy", 0], ["lazy", 1], ["timid", 0]] as [BrainPolicy, number][]) {
      const res = await run(policy, f);
      runs.push({ name: `${policy}${f ? `（追加調査${f}回）` : ""}`, res });
      expect(res.sum.autoHarm, `${policy}: 誤った自動グループ化 ${res.rows.filter((r) => r.s.autoHarm).map((r) => r.id).join(",")}`).toBe(0);
    }
  });

  it("慎重なAI: 自動の適合率100%・再現率は高く、取りこぼしは保守的な側（候補・単独）に倒れる。過剰なAIは、検証層なしなら誤ってまとめる件数が出る（検証層の効果）", async () => {
    const careful = runs.find((r) => r.name === "careful")!.res;
    expect(careful.sum.precisionAuto).toBe(1);
    expect(careful.sum.recallAuto!).toBeGreaterThanOrEqual(0.85);
    const eager = runs.find((r) => r.name === "eager")!.res;
    expect(eager.sum.ungatedWrong).toBeGreaterThan(3); // 検証層が無ければ、誤ってまとめていた件数
    expect(eager.sum.autoHarm).toBe(0);
    expect(runs.find((r) => r.name === "timid")!.res.sum.autoPredicted).toBe(0);
    // 追加調査で、読み忘れた情報源の確認ができ、自動になる件数が増える（同じ予算の中）
    const lazy0 = runs.find((r) => r.name === "lazy")!.res.sum;
    const lazy1 = runs.find((r) => r.name === "lazy（追加調査1回）")!.res.sum;
    expect(lazy1.autoHits).toBeGreaterThan(lazy0.autoHits);
    expect(lazy1.autoHarm).toBe(0);
  });

  it("再現性: 同じ入力は同じ結果", async () => {
    const a = await run("careful");
    const b = await run("careful");
    expect(a.rows.map((r) => r.tier)).toEqual(b.rows.map((r) => r.tier));
  });

  it("レポートを出力する（eval/runs/lottery-grouping-report.md）", () => {
    const L: string[] = ["# 抽選グループ判定の評価レポート（Stage 8F）", "", "モックAI × 検証層、40の架空シナリオ。**実際のAI（実API）の精度ではない**（実APIでの評価は、費用と条件を報告して承認を得たあとに別途行う）。", ""];
    L.push("## 方針別の結果", "", "| 方針 | 誤った自動 | 自動の適合率 | 自動の再現率 | 自動→確認に回した | 自動の取りこぼし | 確認すべきものを提示 | 確認すべきものの取りこぼし | 余計な提案 | 【検証層なしなら】誤ってまとめた | 【検証層なしなら】確認なしでまとめた |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const { name, res } of runs) {
      const s = res.sum;
      L.push(`| ${name} | **${s.autoHarm}** | ${pct(s.precisionAuto)} | ${pct(s.recallAuto)} (${s.autoHits}/${s.labelAuto}) | ${s.autoToSuggest} | ${s.autoMissed} | ${s.reviewHits} | ${s.reviewMissed} | ${s.noise} | ${s.ungatedWrong} | ${s.ungatedUnreviewed} |`);
    }
    for (const name of ["careful", "eager"]) {
      const res = runs.find((r) => r.name === name)!.res;
      L.push("", `## シナリオ別（${name}）`, "", "| ID | 正解 | 結果 | 信頼度 | 内容 | 検証の結論 |", "|---|---|---|---|---|---|");
      for (const r of res.rows) L.push(`| ${r.id} | ${r.label} | ${r.tier} | ${r.confidence} | ${r.title} | ${r.reason.replace(/\|/g, "／")} |`);
    }
    mkdirSync("eval/runs", { recursive: true });
    writeFileSync("eval/runs/lottery-grouping-report.md", L.join("\n") + "\n");
    expect(L.length).toBeGreaterThan(10);
  });
});
