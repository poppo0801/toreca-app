// @vitest-environment node
/**
 * Stage 10V: 実AI評価の条件別の準備（**有料・未実行**。ゲートは JUDGMENT_10V_REAL=1 と費用の承認。承認が無ければ実行しない）。条件を分けて、名称・入力・比較対象を一致させる:
 *  - B（発見・対応付け）: X投稿から応募先を**発見・関連付ける**。入力は保存済みの投稿＋項目ごとの展開結果（linkMap）。**保存データにlinkMapが無い**（実測: 項目382件中、項目自身のリンク0・短縮未展開298・URLなし84）ため、
 *      実データでは評価できない（開発用X APIキーでの収集か、人が展開結果を検証した例が必要）。無い間は実行せず「実例不足」と記録する。
 *  - C（登録判断）: 10Sで**人が回答した実例**（正解は人の回答のみ。判断不能・未回答は分母外）。入力は保存済みの原文のみ（応募ページは取得できない＝取得欠落として別計上）。AIに正解を渡さない。
 *  A（応募URL既知）は research-10u-real.test.ts（10V-A）。
 * 上限（承認時に再確認）: AI 90回・¥50・1対象¥3・対象12。本番・DB・外部サイトには接続しない。出力は eval/real-data/（Git管理外）。結果は観測であり、旧方式・過去のAI出力を正解にしない。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CallBudget } from "../call-budget";
import { checkJudgmentRealRun } from "../real-gate";
// @ts-expect-error plain JS module
import { currentOf } from "../../../../scripts/lib/groundtruth.mjs";
import { makeAnthropicRegistrationJudge, makeAnthropicResearchAgent } from "./research-ai";
import { runResearch, seedEvidence, type ResearchTools } from "./research-loop";

vi.mock("server-only", () => ({}));
const env = process.env;
const REVIEW = "eval/real-data/human-review-10s.json";
const ANSWERS = "eval/real-data/human-review-10s-answers.json";

describe.skipIf(env.JUDGMENT_10V_REAL !== "1" || !existsSync(REVIEW) || !existsSync(ANSWERS))("10V-C 人の確認が済んだ実例での登録判断（実AI・有料）", () => {
  it("応募単位の判断を、人の回答（正しい/誤り）だけと比べる。判断不能・未回答は分母に入れない。取得欠落は別計上", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const cases = (JSON.parse(readFileSync(REVIEW, "utf8")) as { cases: { id: string; real: boolean; sourceText: string[] }[] }).cases.filter((c) => c.real && c.id.startsWith("r10:"));
    const store = JSON.parse(readFileSync(ANSWERS, "utf8"));
    const decided = cases.filter((c) => {
      const a = currentOf(store, c.id);
      return a && (a.verdict === "correct" || a.verdict === "wrong");
    });
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const budget = new CallBudget({ maxCalls: 90, maxCostJpy: Math.min(50, gate.totalCapJpy) });
    const agent = makeAnthropicResearchAgent(client, { model: gate.model });
    const judge = makeAnthropicRegistrationJudge(client, { model: gate.model });
    let tick = Date.now();
    const tools: ResearchTools = { now: () => new Date((tick += 500)), fetchPage: async () => ({ ok: false, reason: "not_public" }) }; // 保存データには応募ページが無い（取得欠落）
    const out: Record<string, unknown>[] = [];
    for (const c of decided.slice(0, 12)) {
      // 種は原文のみ（人の回答・旧方式の結果・AIの過去の回答は渡さない）。応募単位は項目名 apply_unit で出力させる
      const r = await runResearch({ caseId: c.id, seed: seedEvidence("s1", `${c.sourceText.join("\n")}\n（出力項目: apply_unit=応募単位）`, new Date()), agent, judge, tools, budget, limits: { maxTurns: 3, maxFetches: 2 } });
      const unit = r.registration.output?.fields.apply_unit;
      out.push({ case: c.id, human: currentOf(store, c.id)?.verdict, humanUnit: currentOf(store, c.id)?.correctUnit ?? null, end: r.investigation.reason, decision: r.registration.decision, verified: r.registration.verified, aiUnit: unit?.value ?? null, aiUnitBasis: unit?.basis ?? null, fetchAttempts: r.history.length });
    }
    writeFileSync("eval/real-data/xsource-10v-c.json", JSON.stringify({ condition: "C_human_reviewed（応募ページ取得不可=取得欠落を含む）", note: "人の回答だけと比較する。標本が小さく一般化しない", budget: budget.summary(), cases: out }, null, 1));
    expect(budget.calls).toBeLessThanOrEqual(90);
    expect(budget.costJpy).toBeLessThanOrEqual(50.01);
  }, 1_800_000);
});

describe("10V-B 発見・対応付けの実評価は、保存データに項目別の展開結果（linkMap）が無い間は行わない", () => {
  it("実行条件を明示: JUDGMENT_10V_REAL でも、linkMap のある検証済みの例が無ければ実施しない（実例不足）", () => {
    const hasLinkMapExamples = existsSync("eval/real-data/xsource-10v-linkmap-examples.json");
    expect(hasLinkMapExamples).toBe(false); // 現状は不在（実X API・検証済みの展開結果が無い）。出現したときは評価を設計し直す
  });
});
