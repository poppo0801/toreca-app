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

describe("F1 時計の分離（Phase 3 RUNTIME_CORRECTNESS）", () => {
  const limits = { maxTurns: 5, maxFetches: 3, maxElapsedMs: 60_000, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, maxRevisions: 0, maxSearches: 0, searchReserveJpy: 0 } as never;
  it("基準時刻（now）が収集時刻に固定されていても、経過時間は実時刻（wallNow）で進み、時間切れ・残り時間・取得時刻が正しい", async () => {
    let wall = Date.parse("2026-11-26T01:00:00Z");
    const inputs: AgentTurnInput[] = [];
    const agent: ResearchAgent = async (i) => { inputs.push(i); wall += 40_000; return turn({ kind: "fetch", url: `https://shop.example/p${inputs.length}`, why: "w" }); };
    const r = await runResearch({ caseId: "c", seed: seedEvidence("s1", "x", NOW), agent, judge, tools: { now: () => NOW, wallNow: () => new Date(wall), fetchPage: async (u) => ({ ok: true, finalUrl: u, html: `<html><body><h1>${u}</h1></body></html>`, text: u }) }, budget: new CallBudget({ maxCalls: 30, maxCostJpy: 100 }), limits });
    expect(r.investigation.reason).toBe("limit_time"); // 旧実装: 固定の基準時刻で経過0のまま、時間切れにならない
    expect(inputs[0].remaining.elapsedMs).toBe(60_000);
    expect(inputs[1].remaining.elapsedMs).toBe(20_000);
    expect(r.evidence.find((e) => e.kind === "page")?.fetchedAt).toBe("2026-11-26T01:00:40.000Z"); // 取得時刻は実時刻（基準時刻ではない）
  });
  it("呼び出し全体の打ち切り時刻（researchDeadlineMs）を過ぎたら調査を終えて判断へ進む", async () => {
    let wall = 1_000_000;
    let judged = 0;
    let k = 0;
    const agent: ResearchAgent = async () => { wall += 30_000; return turn({ kind: "fetch", url: `https://shop.example/q${++k}`, why: "w" }); };
    const r = await runResearch({ caseId: "c", seed: seedEvidence("s1", "x", NOW), agent, judge: async (i) => (judged++, judge(i)), tools: { now: () => NOW, wallNow: () => new Date(wall), researchDeadlineMs: 1_000_000 + 45_000, fetchPage: async (u) => ({ ok: true, finalUrl: u, html: `<html><body><h1>${u}</h1></body></html>`, text: u }) }, budget: new CallBudget({ maxCalls: 30, maxCostJpy: 100 }), limits });
    expect(r.investigation.reason).toBe("limit_time");
    expect(r.investigation.turns).toBe(2);
    expect(judged).toBe(1);
  });
});

describe("F2 費用の正確性（呼び出しごとの予約・実費の計上・再試行の予約）", () => {
  const limits = { maxTurns: 1, maxFetches: 0, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, maxRevisions: 0, maxSearches: 0, searchReserveJpy: 0 } as never;
  const mk = (seq: ({ out: JudgeOutput | null; rec?: { retryable: boolean; costJpy: number | null } })[]) => {
    let i = 0;
    const f = (async () => { const x = seq[Math.min(i++, seq.length - 1)]; (f as unknown as { lastCall?: unknown }).lastCall = x.rec; return x.out; }) as unknown as RegistrationJudge;
    return { f, calls: () => i };
  };
  const ok = { decision: "tentative", fields: {}, rationale: "r", unresolvedImpact: "minor", monitor: { continue: true, why: "w" }, costJpy: 0.2 } as JudgeOutput;
  const stop: ResearchAgent = async () => turn({ kind: "stop", reason: "sufficient", why: "w" });
  const run = (j: RegistrationJudge) => { const b = new CallBudget({ maxCalls: 30, maxCostJpy: 100 }); return runResearch({ caseId: "c", seed: seedEvidence("s1", "x", NOW), agent: stop, judge: j, tools: { now: () => NOW, fetchPage: async () => ({ ok: false, reason: "not_public" as const }) }, budget: b, limits }).then((r) => ({ r, b })); };
  it("形の不備（課金あり）→再試行で成功: 2回とも予約を取り、不備の実費と成功の実費を両方計上する", async () => {
    const j = mk([{ out: null, rec: { retryable: true, costJpy: 0.3 } }, { out: ok }]);
    const { r, b } = await run(j.f);
    expect(j.calls()).toBe(2);
    expect(r.registration.finalDecision).toBe("tentative");
    expect(b.byKind.registration_judge).toEqual({ calls: 2, costJpy: expect.closeTo(0.5, 6) });
    expect(r.trace.some((t) => t.detail === "retry_recovered")).toBe(true);
  });
  it("課金なしの拒否は0円・費用不明（例外等）は予約額・再試行しない種類は1回だけ", async () => {
    const rej = mk([{ out: null, rec: { retryable: false, costJpy: 0 } }]);
    const a = await run(rej.f);
    expect(rej.calls()).toBe(1);
    expect(a.b.byKind.registration_judge.costJpy).toBe(0);
    const unk = mk([{ out: null }]);
    const c = await run(unk.f);
    expect(c.b.byKind.registration_judge.costJpy).toBeCloseTo(0.6, 6); // 不明は保守的に予約額
    const bad2 = mk([{ out: null, rec: { retryable: true, costJpy: 0.3 } }, { out: null, rec: { retryable: true, costJpy: 0.25 } }]);
    const d = await run(bad2.f);
    expect(bad2.calls()).toBe(2); // 再試行は1回まで
    expect(d.b.byKind.registration_judge.costJpy).toBeCloseTo(0.55, 6);
    expect(d.r.trace.some((t) => t.detail === "retry_failed")).toBe(true);
  });
});

describe("F4 判断から調査へ戻る（重大な不足のときだけ1回）", () => {
  const limits = { maxTurns: 4, maxFetches: 3, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, maxRevisions: 0, maxSearches: 0, searchReserveJpy: 0 } as never;
  const j = (o: Partial<JudgeOutput>): JudgeOutput => ({ decision: "tentative", fields: {}, rationale: "応募先のページが未確認", unresolvedImpact: "material", monitor: { continue: true, why: "w" }, costJpy: 0.1, ...o });
  const setupR = (judges: (JudgeOutput | null)[]) => {
    const inputs: AgentTurnInput[] = [];
    let k = 0;
    const agent: ResearchAgent = async (i) => (inputs.push(i), turn({ kind: "stop", reason: "sufficient", why: "w" }));
    const judge: RegistrationJudge = async () => judges[Math.min(k++, judges.length - 1)];
    const run = () => runResearch({ caseId: "c", seed: seedEvidence("s1", "x", NOW), agent, judge, tools: { now: () => NOW, fetchPage: async () => ({ ok: false, reason: "not_public" as const }) }, budget: new CallBudget({ maxCalls: 30, maxCostJpy: 100 }), limits });
    return { inputs, run, judged: () => k };
  };
  it("判断が重大な不足で暫定にしたら、その不足を調査AIに渡して1回だけ戻り、戻った後の判断を採用する", async () => {
    const s = setupR([j({}), j({ decision: "tentative", unresolvedImpact: "minor", rationale: "再調査後" })]);
    const r = await s.run();
    expect(s.inputs).toHaveLength(2);
    expect(s.inputs[0].judgeFeedback).toBeUndefined();
    expect(s.inputs[1].judgeFeedback).toContain("応募先のページが未確認");
    expect(s.judged()).toBe(2);
    expect(r.registration.output?.rationale).toBe("再調査後");
    expect(r.trace.some((t) => t.detail === "resume_research")).toBe(true);
  });
  it("軽微な不足・登録・除外では戻らない。戻った後の判断が得られなければ最初の判断を使う", async () => {
    const a = setupR([j({ unresolvedImpact: "minor" })]);
    await a.run();
    expect(a.inputs).toHaveLength(1);
    const b = setupR([j({ decision: "register", unresolvedImpact: "material" })]);
    await b.run();
    expect(b.inputs).toHaveLength(1);
    const c = setupR([j({}), null]);
    const rc = await c.run();
    expect(c.judged()).toBe(2);
    expect(rc.registration.output?.rationale).toBe("応募先のページが未確認");
    expect(rc.registration.verified).toBe(true);
  });
});

describe("RUNTIME_CORRECTNESS: AIへの提示の欠落の是正", () => {
  it("受付枠が13件以上でも、13件目以降の名称を省略せず提示する（店舗・地域の判断に必要）", async () => {
    const { structureToObservations } = await import("./page-structure");
    const slots = Array.from({ length: 28 }, (_, i) => ({ title: `店舗${i + 1}`, statusTags: [], details: [], notes: [] }));
    const obs = structureToObservations({ recognized: true, siteKind: "livepocket_like", title: "t", pageNotes: [], slots, relatedEvents: [], formChoices: [], formQuestions: [], gaps: [] } as never);
    const line = obs.find((o) => o.startsWith("受付枠13〜28の名称"));
    expect(line).toContain("28「店舗28」");
    expect(obs.join("\n")).not.toContain("省略）");
  });
  it("調査AIの道具: 取得を選ぶときのURLは必須（空のURLの取得は停止として扱い、その事実を記録する）", async () => {
    const { makeAnthropicResearchAgent } = await import("./research-ai");
    const seen: string[] = [];
    const reqs: { tools: { input_schema: { properties: { next: { required: string[] } } } }[] }[] = [];
    const client = { messages: { create: async (req: never) => (reqs.push(req), { stop_reason: "tool_use", content: [{ type: "tool_use", name: "submit_research_turn", input: { observed: [], unknown: [], next: { kind: "fetch", url: "", why: "w" } } }], usage: { input_tokens: 1, output_tokens: 1 } }) } } as never;
    const out = await makeAnthropicResearchAgent(client, { onDiagnostic: (d) => seen.push(d.reason) })({ caseId: "c", evidence: [], history: [], remaining: { turns: 1, fetches: 1, costJpy: 1, elapsedMs: 1 } });
    expect(out?.next.kind).toBe("stop");
    expect(seen).toContain("next:stop:other:fetch_without_url");
    expect(reqs[0].tools[0].input_schema.properties.next.required).toEqual(expect.arrayContaining(["url", "reason"])); // 終了理由も必須（本番で、理由の欄が省かれ why に JSON の断片が混ざり「other」になった）
  });
});
