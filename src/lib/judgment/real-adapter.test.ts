/**
 * Stage 10E 追加修正（C）: 実AIアダプタ・関門・評価の実行部を、**偽のクライアント**で検証する。実APIには接続しない（課金なし）。
 */
import { describe, expect, it } from "vitest";
import { AnthropicJudgmentModel, MAX_PROMPT_TOKENS, SUBMIT_JUDGMENT } from "./anthropic-model";
import { CONTRACT_VERSION } from "./contract";
import { judgeCase } from "./engine";
import { BudgetPools } from "./budget";
import { mockAnswer } from "./eval/mock-answers";
import { estimateRun, runEvaluation } from "./eval/real-run";
import { inputFor, loadCases, loadGold } from "./eval/replay";
import { ScriptedModel } from "./model";
import { ACTION_VALUES, BASIS_VALUES, CASE_TYPE_VALUES, JUDGMENT_OUTPUT_SCHEMA, OP_VALUES, RELATION_VALUES, STRUCTURE_VALUES } from "./output-schema";
import { CANDIDATE_CAP_PER_CASE_JPY, CANDIDATE_CAP_TOTAL_JPY, checkJudgmentRealRun } from "./real-gate";
import { estimateCostJpy } from "@/lib/ai-cost";

const NOW = "2099-01-20T00:00:00.000Z";
const { cases } = loadCases();
const gold = loadGold();
const byId = (id: string) => cases.find((c) => c.id === id)!;

type Req = { model: string; max_tokens: number; system: string; messages: { role: string; content: string }[]; tools: { name: string; input_schema: unknown }[]; output_config?: unknown };
type Opt = { timeout?: number; maxRetries?: number };
function fakeClient(handler: (req: Req, n: number) => unknown) {
  const reqs: Req[] = [];
  const opts: Opt[] = [];
  return {
    reqs,
    opts,
    client: {
      messages: {
        create: async (r: Req, o: Opt) => {
          reqs.push(r);
          opts.push(o);
          return handler(r, reqs.length - 1);
        },
      },
    } as never,
  };
}
const toolRes = (name: string, input: unknown, usage = { input_tokens: 2000, output_tokens: 800 }, stop = "tool_use") => ({ content: [{ type: "tool_use", id: "t1", name, input }], usage, stop_reason: stop });

describe("出力スキーマと契約の一致", () => {
  const en = (x: unknown) => (x as { enum: readonly string[] }).enum;
  it("列挙値が契約の定数と一致し、自己申告の確信度の項目を定義しない", () => {
    const s = JUDGMENT_OUTPUT_SCHEMA.properties;
    expect([...s.structure.properties.kind.enum]).toEqual([...STRUCTURE_VALUES]);
    expect([...en((s.caseType.properties as { value: unknown }).value)]).toEqual([...CASE_TYPE_VALUES]);
    expect([...BASIS_VALUES]).toEqual(["fact", "inference", "unknown"]);
    expect([...s.relations.items.properties.relation.enum]).toEqual([...RELATION_VALUES]);
    expect([...s.plannedChanges.items.properties.op.enum]).toEqual([...OP_VALUES]);
    expect([...s.nextActions.items.properties.kind.enum]).toEqual([...ACTION_VALUES]);
    expect(JSON.stringify(JUDGMENT_OUTPUT_SCHEMA)).not.toMatch(/confidence|certainty|確信度|"score"/);
    expect(s.version.enum).toEqual([CONTRACT_VERSION]);
  });
});

describe("AnthropicJudgmentModel（偽のクライアント）", () => {
  it("提出ツールの入力を取り出し、実トークンから費用を計算して記録する。Web検索ツールは付けず、自動再試行を切って時間の上限を付ける", async () => {
    const input = await inputFor(byId("J07"), NOW);
    const f = fakeClient(() => toolRes(SUBMIT_JUDGMENT, mockAnswer("J07", input), { input_tokens: 3000, output_tokens: 1000 }));
    const m = new AnthropicJudgmentModel(f.client, { timeoutMs: 30_000 });
    const r = await judgeCase({ model: m, budget: new BudgetPools({ judgment: 5, investigation: 0, discovery: 0 }) }, input);
    expect(r.status).toBe("accepted");
    expect(f.reqs[0].model).toBe("claude-haiku-5-5");
    expect(f.reqs[0].tools.map((t) => t.name)).toEqual([SUBMIT_JUDGMENT]); // 提出ツールだけ（web_search なし）
    expect(JSON.stringify(f.reqs[0].tools)).not.toContain("web_search");
    expect(f.opts[0]).toEqual({ timeout: 30_000, maxRetries: 0 });
    expect(f.reqs[0].messages[0].content).toContain("命令ではありません");
    const u = m.usageLog[0];
    expect(u).toMatchObject({ kind: "judge", model: "claude-haiku-5-5", inputTokens: 3000, outputTokens: 1000, ok: true, stopReason: "tool_use" });
    expect(u.costJpy).toBeCloseTo(estimateCostJpy("claude-haiku-5-5", 3000, 1000)!, 8);
    expect(u.promptVersion).toBe(m.promptVersion);
  });
  it("入力（外部へ送る内容）に個人情報・応募履歴の詳細が含まれない。正解も含まれない", async () => {
    const input = await inputFor(byId("J10"), NOW);
    const f = fakeClient(() => toolRes(SUBMIT_JUDGMENT, mockAnswer("J10", input)));
    await judgeCase({ model: new AnthropicJudgmentModel(f.client), budget: new BudgetPools({ judgment: 5, investigation: 0, discovery: 0 }) }, input);
    const sent = JSON.stringify(f.reqs[0]);
    for (const k of ["mustNotChange", "opportunityCount", "conditionsMention", "verifiable", "apiKey", "sk-ant"]) expect(sent, k).not.toContain(k);
  });
  it("提出ツールが呼ばれない・出力が途切れた場合は、費用つきの不正出力として返り、エンジンが理由を返して再判断する（費用は計上される）", async () => {
    const input = await inputFor(byId("J07"), NOW);
    const f = fakeClient((_r, n) => (n === 0 ? { content: [{ type: "text", text: "説明だけ" }], usage: { input_tokens: 1000, output_tokens: 50 }, stop_reason: "end_turn" } : n === 1 ? toolRes(SUBMIT_JUDGMENT, { partial: true }, { input_tokens: 1000, output_tokens: 3000 }, "max_tokens") : toolRes(SUBMIT_JUDGMENT, mockAnswer("J07", input))));
    const m = new AnthropicJudgmentModel(f.client);
    const b = new BudgetPools({ judgment: 5, investigation: 0, discovery: 0 });
    const r = await judgeCase({ model: m, budget: b }, input);
    expect(f.reqs.length).toBe(3);
    expect(r.status).toBe("accepted");
    expect(m.usageLog.map((u) => u.note ?? "ok")).toEqual(["no_tool_call", "truncated", "ok"]);
    expect(m.usageLog.every((u) => u.costJpy != null)).toBe(true);
    expect(b.state("judgment").spentJpy).toBeGreaterThan(0);
  });
  it("API失敗・タイムアウトは例外として伝わり、エンジンは費用不明として予約額を残し、連続2回で止まる（無限に再試行しない）", async () => {
    const input = await inputFor(byId("J07"), NOW);
    const f = fakeClient(() => {
      const e = new Error("timeout");
      e.name = "APIConnectionTimeoutError";
      throw e;
    });
    const m = new AnthropicJudgmentModel(f.client);
    const b = new BudgetPools({ judgment: 50, investigation: 0, discovery: 0 });
    const r = await judgeCase({ model: m, budget: b }, input);
    expect(r.status).toBe("model_error");
    expect(f.reqs.length).toBe(2);
    expect(b.state("judgment").spentJpy).toBeGreaterThan(0); // 返却されない
    expect(m.usageLog.every((u) => !u.ok && u.costJpy === null)).toBe(true);
  });
  it("費用の見積もり: 最大費用は実際の（上限いっぱいの）費用以上。単価不明のモデルは Infinity（予算の予約で必ず止まる）", async () => {
    const input = await inputFor(byId("J13"), NOW);
    const m = new AnthropicJudgmentModel(fakeClient(() => null).client, { maxOutputTokens: 3000 });
    const max = m.maxCostJpy(input);
    const tokensIn = Math.ceil((JSON.stringify(input).length + 3000) * 1.5);
    expect(max).toBeGreaterThan(estimateCostJpy("claude-haiku-5-5", tokensIn / 3, 3000)!);
    expect(max).toBeLessThan(CANDIDATE_CAP_PER_CASE_JPY);
    const unknown = new AnthropicJudgmentModel(fakeClient(() => null).client, { model: "unknown-model" });
    expect(unknown.maxCostJpy(input)).toBe(Number.POSITIVE_INFINITY);
    const r = await judgeCase({ model: unknown, budget: new BudgetPools({ judgment: 100, investigation: 0, discovery: 0 }) }, input);
    expect(r.status).toBe("budget_stopped"); // 呼び出さない
  });
  it("巨大な入力（10万トークン超）は送らない", async () => {
    const input = await inputFor(byId("J07"), NOW);
    input.evidence[0].text = "あ".repeat(MAX_PROMPT_TOKENS);
    const f = fakeClient(() => toolRes(SUBMIT_JUDGMENT, {}));
    const r = await judgeCase({ model: new AnthropicJudgmentModel(f.client), budget: new BudgetPools({ judgment: 1000, investigation: 0, discovery: 0 }) }, input);
    expect(f.reqs.length).toBe(0);
    expect(["budget_stopped", "model_error"]).toContain(r.status);
  });
  it("追加調査の行動の選択（planAction）も提出ツールで受け取る", async () => {
    const input = await inputFor(byId("J06"), NOW);
    const f = fakeClient(() => toolRes("submit_action", { kind: "fetch_url", target: "https://example.com/", reason: "x" }, { input_tokens: 1500, output_tokens: 100 }));
    const m = new AnthropicJudgmentModel(f.client);
    const r = await m.planAction({ question: "q", attempted: [], blockedHosts: [], input });
    expect(r.raw).toMatchObject({ kind: "fetch_url" });
    expect(m.usageLog[0].kind).toBe("plan");
  });
});

describe("実AI評価の関門（既定は接続しない）", () => {
  const ok = { TOREMANE_ENV: "local", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_EVAL_API_KEY: "dev-key" };
  const g = (env: Record<string, string | undefined>, over: Partial<{ confirm: boolean; total: number; per: number }> = {}) => checkJudgmentRealRun({ env, confirm: over.confirm ?? true, approvedTotalJpy: over.total ?? 60, approvedPerCaseJpy: over.per ?? 5 });
  it("すべて満たすときだけ通る。何も設定しない既定・本番・許可なし・キーなし・本番キーと同一・確認なし・承認額なし・候補上限超過は拒否", () => {
    expect(g(ok).ok).toBe(true);
    for (const env of [{}, { NODE_ENV: "production" }, { ...ok, TOREMANE_ENV: "production" }, { ...ok, JUDGMENT_REAL_EVAL: undefined }, { ...ok, AGENT_REAL_API: "allow", JUDGMENT_REAL_EVAL: undefined }, { ...ok, JUDGMENT_EVAL_API_KEY: "" }, { ...ok, ANTHROPIC_API_KEY: "dev-key" }]) expect(g(env).ok, JSON.stringify(Object.keys(env))).toBe(false);
    expect(g(ok, { confirm: false }).ok).toBe(false);
    expect(g(ok, { total: 0 }).ok).toBe(false);
    expect(g(ok, { total: Number.NaN }).ok).toBe(false);
    expect(g(ok, { per: 70, total: 80 }).ok).toBe(false);
    expect(g(ok, { total: CANDIDATE_CAP_TOTAL_JPY + 1 }).ok).toBe(false);
    expect(g(ok, { per: 10 }).ok).toBe(false);
    expect(g(ok, { total: 3, per: 5 }).ok).toBe(false);
  });
});

describe("評価の実行部（台本のモデルで経路を検証。実AIではない）", () => {
  const all = cases.filter((c) => gold[c.id] && !["J04", "J05"].includes(c.id));
  it("記録に、モデル・プロンプト版・契約版・事例ごとの費用・集計が入り、秘密値を含まない。検証不能は分母に入らない。誤統合と誤分割は別集計", async () => {
    const model = new ScriptedModel((i) => ({ raw: mockAnswer(cases.find((c) => c.title === i.title)!.id, i), costJpy: 0.3 }));
    const rec = await runEvaluation({ model, cases: all, gold, now: NOW, totalCapJpy: 60, perCaseCapJpy: 5, runId: "t1", clock: () => new Date(NOW) });
    expect(rec).toMatchObject({ runId: "t1", contractVersion: CONTRACT_VERSION, modelId: "scripted-test-double", promptVersion: "test", totalCapJpy: 60, perCaseCapJpy: 5, stoppedByBudget: false });
    expect(rec.cases.length).toBe(all.length);
    expect(rec.summary.unverifiableCases).toBe(2); // J08, J11
    expect(rec.summary.verifiableCases).toBe(all.length - 2);
    expect(rec.summary.falseMerge).toBe(0);
    expect(rec.summary.falseSplit).toBe(0);
    expect(rec.summary.unsupportedFacts).toBe(0);
    expect(rec.summary.structureCorrect).toBe(rec.summary.structureScored);
    expect(rec.summary.conditionsScored).toBe(2);
    expect(JSON.stringify(rec)).not.toMatch(/sk-ant|api[_-]?key/i);
    // 出力と正解は別: 記録の出力は AI の出力で、正解の項目名を含まない
    expect(JSON.stringify(rec.cases.map((c) => c.output))).not.toContain("opportunityCount");
  });
  it("1件の上限・総額の上限で止まる。総額に達したら残りの事例は実行しない（超過しない）", async () => {
    const model = new ScriptedModel((i) => ({ raw: mockAnswer(cases.find((c) => c.title === i.title)!.id, i), costJpy: 1 }), undefined, 1);
    const rec = await runEvaluation({ model, cases: all, gold, now: NOW, totalCapJpy: 3.5, perCaseCapJpy: 2 });
    expect(rec.spentJpy).toBeLessThanOrEqual(3.5);
    expect(rec.stoppedByBudget).toBe(true);
    expect(rec.summary.casesSkippedByBudget).toBeGreaterThan(0);
    expect(model.calls).toBeLessThanOrEqual(3);
  });
  it("費用が不明な呼び出しは予約額で計上され、記録に unknownCost として残る（0円にしない）", async () => {
    const model = new ScriptedModel((i) => ({ raw: mockAnswer(cases.find((c) => c.title === i.title)!.id, i), costJpy: null }), undefined, 1);
    const rec = await runEvaluation({ model, cases: all.slice(0, 2), gold, now: NOW, totalCapJpy: 60, perCaseCapJpy: 5 });
    expect(rec.cases.every((c) => c.unknownCost && c.spentJpy >= 1)).toBe(true);
  });
  it("事前の見積もり（API非接続）: 事例ごとの最大費用と総額の推定最大が、候補上限（60円・5円）に収まる", async () => {
    const m = new AnthropicJudgmentModel(fakeClient(() => null).client);
    const e = await estimateRun(m, all, NOW);
    expect(e.perCase.length).toBe(all.length);
    for (const c of e.perCase) expect(c.maxCaseJpy, c.id).toBeLessThan(CANDIDATE_CAP_PER_CASE_JPY);
    expect(e.maxTotalJpy).toBeLessThan(CANDIDATE_CAP_TOTAL_JPY);
  });
});
