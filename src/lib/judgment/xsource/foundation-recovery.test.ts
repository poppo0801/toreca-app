// @vitest-environment node
/**
 * Phase 3 FOUNDATION_RECOVERY: 調査ループの事前取得（autoFetch）。収集時の取得元ページ（応募先が未確定の項目のとき）を、AIの最初の行動の前にループ自身が取得し、
 * AIの最初の入力に入れる。実本番の再評価で、AIが取得できる取得元ページを一度も見ずに「全文は未確認」と暫定にした（取りこぼし）ことの再現と是正。
 * 取得は通常の取得と同じ経路（安全検査・履歴・回数の計上）。AIの判断は変えない（入力が増えるだけ）。
 */
import { describe, expect, it } from "vitest";
import { CallBudget } from "../call-budget";
import { pageTextChecked } from "./html-text";
import { runResearch, seedEvidence, type AgentTurnInput, type AgentTurnOutput, type FetchOutcome, type JudgeOutput, type RegistrationJudge, type ResearchAgent, type ResearchTools } from "./research-loop";

const NOW = new Date("2026-11-24T21:05:00Z");
const URL1 = "https://shop.example/items/1";
const html = `<html><head><title>商品A | サイトB</title></head><body><h1>商品A 抽選受付</h1><p>応募期間 11月24日〜11月26日</p></body></html>`;
const turn = (next: AgentTurnOutput["next"]): AgentTurnOutput => ({ observed: [], inferred: [], unknown: [], counterHypotheses: [], next, costJpy: 0.1 });
const judge: RegistrationJudge = async () => ({ decision: "tentative", fields: {}, rationale: "r", unresolvedImpact: "minor", monitor: { continue: true, why: "w" }, costJpy: 0.1 } as JudgeOutput);
const setup = (fetchImpl?: ResearchTools["fetchPage"]) => {
  const inputs: AgentTurnInput[] = [];
  const fetched: string[] = [];
  const agent: ResearchAgent = async (i) => (inputs.push(i), turn({ kind: "stop", reason: "sufficient", why: "十分" }));
  let t = NOW.getTime();
  const ok: FetchOutcome = { ok: true, finalUrl: URL1, html, text: pageTextChecked(html, []).text, fetchedAt: "2026-11-24T21:00:00.000Z" };
  const tools: ResearchTools = { now: () => new Date((t += 1000)), fetchPage: async (u) => (fetched.push(u), fetchImpl ? fetchImpl(u) : ok) };
  const run = (autoFetch?: string[]) => runResearch({ caseId: "c", seed: seedEvidence("s1", "投稿の本文", NOW), agent, judge, tools, budget: new CallBudget({ maxCalls: 30, maxCostJpy: 100 }), limits: { maxTurns: 3, maxFetches: 3, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, maxRevisions: 0, maxSearches: 0, searchReserveJpy: 0 } as never, ...(autoFetch ? { autoFetch } : {}) });
  return { inputs, fetched, run };
};

describe("調査ループの事前取得（autoFetch）", () => {
  it("事前取得の指定があると、AIの最初の入力に取得したページが証拠として入る（AIが取得を選ばなくても見える）。取得は1回で、履歴に残る", async () => {
    const s = setup();
    const r = await s.run([URL1]);
    expect(s.fetched).toEqual([URL1]);
    expect(s.inputs).toHaveLength(1);
    expect(s.inputs[0].evidence.map((e) => e.kind)).toEqual(["seed", "page"]);
    expect(s.inputs[0].history).toEqual([expect.objectContaining({ outcome: "ok" })]);
    expect(r.evidence.filter((e) => e.kind === "page")).toHaveLength(1);
    expect(r.evidence.find((e) => e.kind === "page")?.fetchedAt).toBe("2026-11-24T21:00:00.000Z"); // 実際の取得時刻（基準時刻ではない）
  });
  it("指定が無い従来の呼び出しは、AIが選ぶまで取得しない（動作は変わらない）", async () => {
    const s = setup();
    await s.run();
    expect(s.fetched).toEqual([]);
    expect(s.inputs[0].evidence.map((e) => e.kind)).toEqual(["seed"]);
  });
  it("取得に失敗しても調査は続く（失敗は履歴に理由つきで残り、AIに見える）。http でない・不正なURLは取得しない。回数は上限の中で数える", async () => {
    const s = setup(async () => ({ ok: false, reason: "robots" }));
    await s.run([URL1]);
    expect(s.inputs[0].history).toEqual([expect.objectContaining({ outcome: "robots" })]);
    const s2 = setup();
    await s2.run(["http://insecure.example/a", "not a url"]);
    expect(s2.fetched).toEqual([]);
    expect(s2.inputs).toHaveLength(1);
    const s3 = setup();
    const r3 = await runResearch({ caseId: "c", seed: seedEvidence("s1", "x", NOW), agent: async () => turn({ kind: "stop", reason: "sufficient", why: "w" }), judge, tools: { now: () => NOW, fetchPage: async () => ({ ok: true, finalUrl: URL1, html, text: "あ".repeat(50) }) }, budget: new CallBudget({ maxCalls: 30, maxCostJpy: 100 }), limits: { maxTurns: 3, maxFetches: 0, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, maxRevisions: 0, maxSearches: 0, searchReserveJpy: 0 } as never, autoFetch: [URL1] });
    expect(r3.evidence.filter((e) => e.kind === "page")).toHaveLength(0); // 取得回数の上限が0なら取得しない
    void s3;
  });
});
