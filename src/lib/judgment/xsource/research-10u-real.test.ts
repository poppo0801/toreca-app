// @vitest-environment node
/**
 * Stage 10U/10V-A: **応募URL既知**の条件での実AI評価（**有料・未実行**。費用の承認が出るまで実行しない）。保存済みの実在の公開ページ（Stage 10T のLivePocket 12ページ。Git管理外）を
 * 「取得ツール」の再生元にし、**応募ページのURLを種に含めた**うえで、ページ構造の読み取り→AIが次に何を調べるか（追加取得・停止）→調査終了→独立した登録判断を通す。
 * **これは「XからURLを発見・関連付ける」力の評価ではない**（その条件は 10V-B: research-10v-real.test.ts。URLが与えられる条件と、発見する条件を混同しない）。本番・DB・外部サイトには接続しない（取得は保存済みHTMLの再生のみ）。
 * 結果は eval/real-data/xsource-10u-real.json（Git管理外）。**正解（人の確認）が無い間は、結果を精度として扱わない**（判断の傾向・取得の進展・費用の観測だけ）。
 * 上限: AI 90回・¥50・1対象¥3×2・対象12。
 * 実行: JUDGMENT_10U_REAL=1 JUDGMENT_REAL_EVAL=allow JUDGMENT_REUSE_EXISTING_KEY=allow JUDGMENT_REAL_CONFIRM=yes JUDGMENT_APPROVED_TOTAL_JPY=50 JUDGMENT_APPROVED_PER_CASE_JPY=3 TOREMANE_ENV=local npx vitest run src/lib/judgment/xsource/research-10u-real.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CallBudget } from "../call-budget";
import { checkJudgmentRealRun } from "../real-gate";
import { makeAnthropicRegistrationJudge, makeAnthropicResearchAgent } from "./research-ai";
import { runResearch, seedEvidence, type ResearchTools } from "./research-loop";

vi.mock("server-only", () => ({}));
const env = process.env;
const DIR = "eval/real-data/10t-html";
describe.skipIf(env.JUDGMENT_10U_REAL !== "1" || env.JUDGMENT_10X_TARGET !== "A" || !existsSync(`${DIR}/index.json`))("10V-A 応募URL既知のページ構造・判断（実AI・有料）", () => {
  it("応募URL既知: 保存済みページの再生で、追加調査→終了→登録判断を通し、観測だけを書き出す", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const index = JSON.parse(readFileSync(`${DIR}/index.json`, "utf8")) as { n: number; url: string; ok: boolean }[];
    const pages = new Map(index.filter((x) => x.ok).map((x) => [x.url, readFileSync(`${DIR}/lp-${x.n}.html`, "utf8")]));
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const budget = new CallBudget({ maxCalls: 90, maxCostJpy: Math.min(50, gate.totalCapJpy) });
    const diagnostics: { role: string; reason: string }[] = [];
    const agent = makeAnthropicResearchAgent(client, { model: gate.model, onDiagnostic: (d) => diagnostics.push(d) });
    const judge = makeAnthropicRegistrationJudge(client, { model: gate.model, onDiagnostic: (d) => diagnostics.push(d) });
    let tick = Date.now();
    const tools: ResearchTools = { now: () => new Date((tick += 500)), fetchPage: async (u) => (pages.has(u) ? { ok: true, finalUrl: u, html: pages.get(u)!, text: pages.get(u)!.replace(/<[^>]+>/g, " ") } : { ok: false, reason: "not_public" }) };
    const out: Record<string, unknown>[] = [];
    for (const x of index.filter((i) => i.ok).slice(0, 12)) {
      // 種（告知）は、ページのタイトルと**応募ページのURL**（条件A: URL既知。URLの発見は評価しない）
      const title = (pages.get(x.url)!.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
      const r = await runResearch({ caseId: `lp-${x.n}`, seed: seedEvidence("s1", `告知: ${title}\n応募ページ: ${x.url}`, new Date()), agent, judge, tools, budget, limits: { maxTurns: 4, maxFetches: 3, agentReserveJpy: 0.6, judgeReserveJpy: 0.6 } });
      out.push({ case: `lp-${x.n}`, end: r.investigation.reason, turns: r.investigation.turns, decision: r.registration.decision, verified: r.registration.verified, held: r.registration.held, monitoring: r.monitoring.state, fetches: r.history.map((h) => h.outcome) });
    }
    writeFileSync("eval/real-data/xsource-10u-real.json", JSON.stringify({ condition: "A_url_known（応募URLを種に含める。発見力の評価ではない）", note: "観測のみ（人の正解が無いため精度ではない）", budget: budget.summary(), diagnostics, cases: out }, null, 1));
    expect(budget.calls).toBeLessThanOrEqual(90);
    expect(budget.costJpy).toBeLessThanOrEqual(50.01);
  }, 1_800_000);
});
