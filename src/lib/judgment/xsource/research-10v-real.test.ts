// @vitest-environment node
/**
 * Stage 10V/10W: 実AI評価の条件別ハーネス（**有料部分は未実行**。ゲートは JUDGMENT_10V_REAL=1 と費用の承認）。条件を分けて、名称・入力・比較対象を一致させる:
 *  - A（応募URL既知）: research-10u-real.test.ts（10V-A）。
 *  - B1（展開・項目スコープ）: **AIを使わない・無料**。`eval/real-data/xsource-10w-linkmap-examples.json`（Git管理外。項目別の展開結果と独立した正解つきの例）があれば実行し、無ければ**評価不能（skipped）**。
 *  - B2（AI自律発見）: 同じ例ファイルを使い、**応募URLを与えず**AIが応募先に到達・対応付けできるかを測る（有料・承認後）。B1の成功をB2の成功と数えない。
 *  - C（登録判断）: 10Sの人の回答のうち、**独立した正解（gold）が確定した例だけ**で採点する（scripts/lib/gold-c.mjs）。gold が最小数に満たない間は正答率を出さない。
 * 上限（承認時に再確認）: AI 90回・¥50・1対象¥3・対象12。本番・DB・外部サイトには接続しない。出力は eval/real-data/（Git管理外）。旧方式・過去のAI出力を正解にしない。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CallBudget } from "../call-budget";
import { checkJudgmentRealRun } from "../real-gate";
// @ts-expect-error plain JS module
import { classifyGold, scoreAgainstGold } from "../../../../scripts/lib/gold-c.mjs";
// @ts-expect-error plain JS module
import { currentOf } from "../../../../scripts/lib/groundtruth.mjs";
import { evaluateB1, evaluateB2, type BExample } from "./eval-b";
import { makeAnthropicRegistrationJudge, makeAnthropicResearchAgent } from "./research-ai";
import { runResearch, seedEvidence, type ResearchTools } from "./research-loop";

vi.mock("server-only", () => ({}));
const env = process.env;
const REVIEW = "eval/real-data/human-review-10s.json";
const ANSWERS = "eval/real-data/human-review-10s-answers.json";
const EXAMPLES = "eval/real-data/xsource-10w-linkmap-examples.json";
const realGate = () => checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
const examples = (): BExample[] => (JSON.parse(readFileSync(EXAMPLES, "utf8")) as { examples: BExample[] }).examples;

describe.skipIf(!existsSync(EXAMPLES))("10W-B1 展開・項目スコープ（無料・AIなし）", () => {
  it("項目別の展開結果と独立した正解がある例で、URLの取り出し・ページの対応の検査を採点する", () => {
    const r = evaluateB1(examples());
    writeFileSync("eval/real-data/xsource-10w-b1.json", JSON.stringify({ condition: "B1_expanded_links_given（展開結果を入力として与える。AIの発見力ではない）", ...r }, null, 1));
    expect(r.items).toBeGreaterThan(0);
  });
});

describe.skipIf(env.JUDGMENT_10V_REAL !== "1" || !existsSync(EXAMPLES))("10W-B2 AI自律発見（実AI・有料・承認後）", () => {
  it("応募URLを与えず、AIが応募先に到達・対応付けできるか（gold のある項目だけ成功/失敗を数える）", async () => {
    const gate = realGate();
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const budget = new CallBudget({ maxCalls: 90, maxCostJpy: Math.min(50, gate.totalCapJpy) });
    const r = await evaluateB2({ examples: examples().slice(0, 12), agent: makeAnthropicResearchAgent(client, { model: gate.model }), judge: makeAnthropicRegistrationJudge(client, { model: gate.model }), budget, limits: { maxTurns: 3, maxFetches: 2 }, now: new Date() });
    writeFileSync("eval/real-data/xsource-10w-b2.json", JSON.stringify({ condition: "B2_url_not_given（応募URLを与えない。検索ツールは無く、AIが提案したURLの取得の範囲）", ...r, budget: budget.summary() }, null, 1));
    expect(budget.calls).toBeLessThanOrEqual(90);
    expect(budget.costJpy).toBeLessThanOrEqual(50.01);
  }, 1_800_000);
});

describe.skipIf(env.JUDGMENT_10V_REAL !== "1" || !existsSync(REVIEW) || !existsSync(ANSWERS))("10W-C 独立した正解（gold）での登録判断（実AI・有料・承認後）", () => {
  it("gold の事例だけを採点する。gold が最小数に満たなければ正答率は出さない。取得欠落は別計上", async () => {
    const gate = realGate();
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const cases = (JSON.parse(readFileSync(REVIEW, "utf8")) as { cases: { id: string; real: boolean; aiUnit?: string; sourceText: string[] }[] }).cases;
    const gold = classifyGold(cases, JSON.parse(readFileSync(ANSWERS, "utf8")), currentOf);
    const targets = cases.filter((c) => gold.rows.some((r: { id: string; category: string }) => r.id === c.id && r.category === "gold"));
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const budget = new CallBudget({ maxCalls: 90, maxCostJpy: Math.min(50, gate.totalCapJpy) });
    const agent = makeAnthropicResearchAgent(client, { model: gate.model });
    const judge = makeAnthropicRegistrationJudge(client, { model: gate.model });
    let tick = Date.now();
    const tools: ResearchTools = { now: () => new Date((tick += 500)), fetchPage: async () => ({ ok: false, reason: "not_public" }) }; // 保存データには応募ページが無い（取得欠落）
    const results: { id: string; aiUnit: string | null; aiUnitBasis: string | null; decision: string; end: string }[] = [];
    for (const c of targets.slice(0, 12)) {
      // 種は原文のみ（人の回答・正解・旧方式の結果・過去のAIの回答は渡さない）。応募単位は項目名 apply_unit で出力させる
      const r = await runResearch({ caseId: c.id, seed: seedEvidence("s1", `${c.sourceText.join("\n")}\n（出力項目: apply_unit=応募単位）`, new Date()), agent, judge, tools, budget, limits: { maxTurns: 3, maxFetches: 2 } });
      const unit = r.registration.output?.fields.apply_unit;
      results.push({ id: c.id, aiUnit: unit?.value ?? null, aiUnitBasis: unit?.basis ?? null, decision: r.registration.decision, end: r.investigation.reason });
    }
    writeFileSync("eval/real-data/xsource-10w-c.json", JSON.stringify({ condition: "C_gold_only（独立した正解がある事例だけ。応募ページ取得不可=取得欠落を含む）", goldCounts: gold.counts, score: scoreAgainstGold(gold, results), results, budget: budget.summary() }, null, 1));
    expect(budget.calls).toBeLessThanOrEqual(90);
    expect(budget.costJpy).toBeLessThanOrEqual(50.01);
  }, 1_800_000);
});
