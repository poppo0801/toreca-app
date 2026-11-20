// @vitest-environment node
/**
 * 統合AI判断の実AI評価の入口（Stage 10E 追加修正）。**通常のテスト実行では何もしない（スキップ）**。実行は `node scripts/eval-judgment-real.mjs …` から、環境変数で指定されたときだけ。
 *  - preflight（JUDGMENT_REAL_PREFLIGHT=1）: 関門の状態と推定最大費用を表示。API・ネットワークに接続しない。キーは表示しない。
 *  - run（JUDGMENT_REAL_RUN=1）: **実API（有料）**。`checkJudgmentRealRun` の全条件（開発環境・評価専用の許可・開発専用キー・承認額・確認）を満たさなければ実行しない。
 *    第1段階: 架空・匿名化済みの評価事例（eval/judgment-10e）のみ。Web検索なし。実原文・本番DBは使わない（第2段階は別途承認）。
 * 結果は eval/runs/judgment-10e/<runId>.json（Git管理外）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnthropicJudgmentModel } from "./anthropic-model";
import { estimateRun, runEvaluation } from "./eval/real-run";
import { loadCases, loadGold } from "./eval/replay";
import { CANDIDATE_CAP_PER_CASE_JPY, CANDIDATE_CAP_TOTAL_JPY, checkJudgmentRealRun } from "./real-gate";

const env = process.env;
const ids = (env.JUDGMENT_REAL_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const pick = () => {
  const { now, cases } = loadCases();
  const gold = loadGold();
  return { now, gold, cases: cases.filter((c) => gold[c.id] && (ids.length ? ids.includes(c.id) : true) && !["J04", "J05"].includes(c.id)) };
};
const approvedTotal = Number(env.JUDGMENT_APPROVED_TOTAL_JPY);
const approvedPer = Number(env.JUDGMENT_APPROVED_PER_CASE_JPY);

describe.skipIf(env.JUDGMENT_REAL_PREFLIGHT !== "1")("実行前の確認（API非接続）", () => {
  it("関門の状態と推定最大費用を表示する", async () => {
    const { now, cases } = pick();
    const model = new AnthropicJudgmentModel({ messages: { create: async () => { throw new Error("preflight は API に接続しません"); } } } as never);
    const est = await estimateRun(model, cases, now);
    const gate = checkJudgmentRealRun({ env, confirm: true, approvedTotalJpy: approvedTotal || CANDIDATE_CAP_TOTAL_JPY, approvedPerCaseJpy: approvedPer || CANDIDATE_CAP_PER_CASE_JPY });
    console.log(JSON.stringify({ model: model.id, cases: cases.map((c) => c.id), gate: gate.ok ? "通過（実行可能）" : `未通過: ${gate.reason}`, candidateCaps: { totalJpy: CANDIDATE_CAP_TOTAL_JPY, perCaseJpy: CANDIDATE_CAP_PER_CASE_JPY }, maxTotalJpy: est.maxTotalJpy, perCase: est.perCase }, null, 2));
    expect(est.perCase.length).toBe(cases.length);
  });
});

describe.skipIf(env.JUDGMENT_REAL_RUN !== "1")("実API評価（有料・承認後のみ）", () => {
  it("第1段階: 架空事例を実AIで判定し、記録を保存する", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: approvedTotal, approvedPerCaseJpy: approvedPer });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const { now, cases, gold } = pick();
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const model = new AnthropicJudgmentModel(new Anthropic({ apiKey: gate.apiKey }), { model: gate.model });
    const est = await estimateRun(model, cases, now);
    if (est.maxTotalJpy > gate.totalCapJpy) console.warn(`推定最大費用 ${est.maxTotalJpy}円が承認額 ${gate.totalCapJpy}円を超える見込み。承認額で止まります`);
    const rec = await runEvaluation({ model, cases, gold, now, totalCapJpy: gate.totalCapJpy, perCaseCapJpy: gate.perCaseCapJpy });
    const dir = join("eval", "runs", "judgment-10e");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${rec.runId}.json`), JSON.stringify({ ...rec, usage: model.usageLog }, null, 2));
    console.log(JSON.stringify({ runId: rec.runId, spentJpy: rec.spentJpy, stoppedByBudget: rec.stoppedByBudget, summary: rec.summary }, null, 2));
  }, 600_000);
});
