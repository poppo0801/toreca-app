// @vitest-environment node
/**
 * Phase 3 AUTONOMY_RESTORATION（V22）: 調査と判断の統合・上位の追加の調査・AIの意味の申告（台本のモデル。実AIではない）。
 * fixture は架空の文面（既存の正解とは別）。モックの成功は実AIの精度ではない。
 */
import { describe, expect, it, vi } from "vitest";
import { CallBudget } from "../call-budget";
import { runResearch, seedEvidence, type AgentTurnInput, type AgentTurnOutput, type JudgeOutput, type RegistrationJudge, type ResearchAgent, type ResearchTools } from "./research-loop";
import { makeAnthropicRegistrationJudge } from "./research-ai";

vi.mock("server-only", () => ({}));

const NOW = new Date("2026-11-25T03:00:00Z");
const tools = (): ResearchTools => ({ now: () => NOW, fetchPage: async () => ({ ok: false, reason: "failed" }) });
const stop: AgentTurnOutput = { observed: [], inferred: [], unknown: [], counterHypotheses: [], next: { kind: "stop", reason: "sufficient", why: "十分" }, costJpy: 0.1 };
const jo = (o: Partial<JudgeOutput>): JudgeOutput => ({ decision: "tentative", fields: {}, rationale: "r", unresolvedImpact: "material", monitor: { continue: true, why: "w" }, costJpy: 0.1, ...o });
const seed = seedEvidence("s1", "【架空店】拡張パック 架空の名前 抽選販売 応募期間 2026年12月1日まで", NOW);
const reg = jo({ decision: "register", unresolvedImpact: "none", productKind: "pokemon_card", fields: { store: { value: "架空店", basis: "observed", evidenceId: "s1", quote: "【架空店】拡張パック" } } });

describe("上位の追加の調査（AUTONOMY_RESTORATION: 上位は同じ資料の読み直しで終わらず、自ら調査してから判断する）", () => {
  it("既定の判断が重大な不明で暫定なら、上位の調査AIが調査の回を行い、上位の判断を採用する。段の記録に残る", async () => {
    const primaryInputs: AgentTurnInput[] = [];
    const upperInputs: AgentTurnInput[] = [];
    const agent: ResearchAgent = async (i) => (primaryInputs.push(i), stop);
    const upperAgent: ResearchAgent = async (i) => (upperInputs.push(i), stop);
    const judge: RegistrationJudge = async () => jo({});
    const upperJudge: RegistrationJudge = async () => reg;
    const r = await runResearch({ caseId: "c", seed, agent, judge, tools: tools(), budget: new CallBudget({ maxCalls: 40, maxCostJpy: 100 }), escalation: { judge: upperJudge, agent: upperAgent, model: "upper", primaryModel: "primary", auditRate: 0 } });
    expect(primaryInputs.length).toBe(1);
    expect(upperInputs.length).toBe(1);
    expect(upperInputs[0].judgeFeedback).toBeTruthy(); // 前の判断の不足が上位に渡る
    expect(r.registration.finalDecision).toBe("register");
    expect((r.judgeTrail ?? []).map((s) => s.stage)).toEqual(["primary", "escalated"]);
    expect(r.judgeTrail?.[1]).toMatchObject({ note: "upper_research", adopted: true, decision: "register" });
  });
  it("AI自身が追加の検討（review）を求めれば、検証を通った登録でも上位が調べ直す。明確な案件（review なし）は一度で完結する", async () => {
    let upperCalls = 0;
    const upperAgent: ResearchAgent = async () => (upperCalls++, stop);
    const base = { caseId: "c", seed, agent: (async () => stop) as ResearchAgent, tools: tools(), budget: new CallBudget({ maxCalls: 40, maxCostJpy: 100 }) };
    await runResearch({ ...base, judge: async () => ({ ...reg, review: { why: "情報源の信頼性が分からない" } }), escalation: { judge: async () => reg, agent: upperAgent, model: "u", auditRate: 0 } });
    expect(upperCalls).toBe(1);
    upperCalls = 0;
    const r = await runResearch({ ...base, budget: new CallBudget({ maxCalls: 40, maxCostJpy: 100 }), judge: async () => reg, escalation: { judge: async () => reg, agent: upperAgent, model: "u", auditRate: 0 } });
    expect(upperCalls).toBe(0);
    expect(r.registration.finalDecision).toBe("register");
  });
  it("上位の調査の結果が検証を通らず、最初の結果は通っていたなら、最初の結果に戻す（追加の調査で判断を失わない）", async () => {
    const upperJudge: RegistrationJudge = async () => jo({ decision: "register", productKind: "pokemon_card", fields: { store: { value: "別店", basis: "observed", evidenceId: "s1", quote: "存在しない引用" } } });
    const r = await runResearch({ caseId: "c", seed, agent: async () => stop, judge: async () => jo({}), tools: tools(), budget: new CallBudget({ maxCalls: 40, maxCostJpy: 100 }), escalation: { judge: upperJudge, agent: async () => stop, model: "u", auditRate: 0 } });
    expect(r.registration.finalDecision).toBe("tentative");
    expect(r.registration.verified).toBe(true);
    expect(r.judgeTrail?.[1]).toMatchObject({ adopted: false });
  });
});

describe("検証の矛盾から調査へ戻る（AUTONOMY_RESTORATION）", () => {
  it("検証を通らない判断は、矛盾の内容を調査AIに渡して調査へ戻る（上位が無ければ同じモデル）。回数は外枠の範囲で有限", async () => {
    const inputs: AgentTurnInput[] = [];
    const agent: ResearchAgent = async (i) => (inputs.push(i), stop);
    const bad = jo({ decision: "register", unresolvedImpact: "none", productKind: "pokemon_card", fields: { store: { value: "架空店", basis: "observed", evidenceId: "s1", quote: "原文に無い引用" } } });
    const r = await runResearch({ caseId: "c", seed, agent, judge: async () => bad, tools: tools(), budget: new CallBudget({ maxCalls: 40, maxCostJpy: 100 }) });
    expect(inputs.length).toBe(2);
    expect(inputs[1].judgeFeedback).toContain("検証で解消できなかった点");
    expect(r.registration.finalDecision).toBe("tentative"); // 根拠の無い断定は通さない
  });
});

describe("最大出力を残りの予算に収める（上位の判断が予約の超過で一度も呼ばれなかった欠陥の是正）", () => {
  it("払える範囲に最大出力を下げる。予算の指定が無い・払える量が小さすぎるときは元のまま（予約が通らず呼ばれない＝上限は守る）", async () => {
    const { affordableMaxTokens, MIN_AFFORDABLE_TOKENS } = await import("./research-ai");
    const want = 21_000;
    const t = affordableMaxTokens("claude-sonnet-5-5", 10_000, 15, want);
    expect(t).toBeLessThan(want);
    expect(t).toBeGreaterThanOrEqual(MIN_AFFORDABLE_TOKENS);
    expect(affordableMaxTokens("claude-sonnet-5-5", 10_000, undefined, want)).toBe(want);
    expect(affordableMaxTokens("claude-sonnet-5-5", 10_000, 0.5, want)).toBe(want);
    expect(affordableMaxTokens("claude-haiku-5-5", 10_000, 15, want)).toBe(want); // 安いモデルは元の上限で払える
  });
});

describe("判断の出力の新しい欄（AIの意味の申告）", () => {
  it("excludeKind・productKind・review を読み取る。不正な値・none は無視する", async () => {
    const mk = (input: unknown) => ({ messages: { create: vi.fn(async () => ({ content: [{ type: "tool_use", name: "submit_registration_judgment", input }], usage: { input_tokens: 10, output_tokens: 10 } })) } }) as never;
    const base = { decision: "exclude", fields: [], rationale: "r", unresolvedImpact: "none", monitor: { continue: false, why: "" } };
    const ji = { caseId: "c", evidence: [], lastTurn: null, investigationEnd: "sufficient", protectedFields: {} } as never;
    const a = await makeAnthropicRegistrationJudge(mk({ ...base, excludeKind: "not_managed_product", productKind: "non_card_goods", review: { needed: true, why: "確かめたい" } }), { strict: false })(ji);
    expect(a).toMatchObject({ excludeKind: "not_managed_product", productKind: "non_card_goods", review: { why: "確かめたい" } });
    const b = await makeAnthropicRegistrationJudge(mk({ ...base, excludeKind: "none", productKind: "weird", review: { needed: false, why: "" } }), { strict: false })(ji);
    expect(b?.excludeKind).toBeUndefined();
    expect(b?.productKind).toBeUndefined();
    expect(b?.review).toBeUndefined();
  });
});
