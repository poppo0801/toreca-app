// @vitest-environment node
/**
 * Phase 3 JUDGMENT_IDENTITY_EFFICIENCY: 構造上の問題 F1〜F4 の是正（台本のモデル。実AIではない）。
 * fixture は架空の文面。モックの成功は実AIの精度ではない。
 */
import { describe, expect, it, vi } from "vitest";
import { CallBudget } from "../call-budget";
import { isInterrupted, runResearch, seedEvidence, type AgentTurnInput, type AgentTurnOutput, type JudgeOutput, type RegistrationJudge, type ResearchAgent, type ResearchTools } from "./research-loop";
import { storedRowInterrupted } from "@/lib/server/proposals/generate";
import { caseBudget } from "@/lib/server/shadow/proposal-job";
import { newAiView, queueDecision } from "@/lib/server/shadow/priority";

vi.mock("server-only", () => ({}));

const NOW = new Date("2026-11-25T03:00:00Z");
const html = (t: string) => `<html><body><p>${t}</p></body></html>`;
const page = (u: string, t: string) => ({ ok: true as const, finalUrl: u, html: html(t), text: t });
const stop: AgentTurnOutput = { observed: [], inferred: [], unknown: [], counterHypotheses: [], next: { kind: "stop", reason: "sufficient", why: "十分" }, costJpy: 0.1 };
const fetchTurn = (url: string): AgentTurnOutput => ({ ...stop, next: { kind: "fetch", url, why: "確かめる" } });
const jo = (o: Partial<JudgeOutput>): JudgeOutput => ({ decision: "tentative", fields: {}, rationale: "r", unresolvedImpact: "material", monitor: { continue: true, why: "w" }, costJpy: 0.1, ...o });
const seed = seedEvidence("s1", "【架空店】拡張パック 架空の名前 抽選販売 応募期間 2026年12月1日まで", NOW);

describe("F1 調査途中の項目は完了扱いにしない・続きから再開する", () => {
  it("時間・予算・呼び出しの枠・障害で打ち切られ、判断が確定していない項目は未完了。検証済みの登録・除外は打ち切られても完了", () => {
    const base = { investigation: { state: "ended" as const, reason: "limit_time" as const, turns: 2 } };
    const g = (o: object) => ({ decision: "tentative", finalDecision: "tentative", output: jo({}), verified: true, held: null, warnings: [], proposals: [], ...o }) as never;
    expect(isInterrupted({ ...base, registration: g({}) })).toBe(true);
    expect(isInterrupted({ ...base, registration: g({ finalDecision: "register", decision: "register" }) })).toBe(false);
    expect(isInterrupted({ investigation: { ...base.investigation, reason: "sufficient" }, registration: g({}) })).toBe(false); // AIが十分と判断した暫定は完了（最終の保留）
    expect(isInterrupted({ investigation: { ...base.investigation, reason: "sufficient" }, registration: g({ output: null, held: { reasons: ["budget_cost"] } }) })).toBe(true);
    expect(storedRowInterrupted({ end_reason: "limit_cost", decision: "tentative", verified: true, held_reasons: [] })).toBe(true);
    expect(storedRowInterrupted({ end_reason: "sufficient", decision: "tentative", verified: true, held_reasons: [] })).toBe(false);
    expect(storedRowInterrupted({ end_reason: "limit_time", decision: "exclude", verified: true, held_reasons: [] })).toBe(false);
  });
  it("続き（carry）: 前回読んだページを最初から証拠に入れ（取得の回数に数えない）、前回の暫定の判断と残りの問いを調査AIに渡す", async () => {
    const inputs: AgentTurnInput[] = [];
    const U = "https://example.invalid/notice";
    const tools: ResearchTools = { now: () => NOW, fetchPage: async (u) => page(u, "架空の告知 応募期間 12月1日まで") };
    await runResearch({ caseId: "c", seed, agent: async (i) => (inputs.push(i), stop), judge: async () => jo({ decision: "register", unresolvedImpact: "none" }), tools, budget: new CallBudget({ maxCalls: 30, maxCostJpy: 100 }), limits: { maxFetches: 2 }, carry: { urls: [U], feedback: "前回の暫定の判断: tentative。前回の残りの問い: 締切の時刻" } });
    expect(inputs[0].evidence.some((e) => e.kind === "page" && e.url === U)).toBe(true);
    expect(inputs[0].remaining.fetches).toBe(2);
    expect(inputs[0].judgeFeedback).toContain("中断");
    expect(inputs[0].judgeFeedback).toContain("締切の時刻");
  });
});

describe("F2 1候補の上限と日次・実行の残額を区別する", () => {
  it("候補の承認額を使い切った→完了扱いの理由／日次の残額が無い→翌日／実行の枠が無い→少し後。上限はDBの承認値（直書きの25円は無い）", () => {
    expect(caseBudget({ perCaseCapJpy: 25, spentOnJobJpy: 25, remainingJpy: 100, runLeftJpy: 100 })).toEqual({ ok: false, reason: "budget_per_case_exhausted" });
    expect(caseBudget({ perCaseCapJpy: 25, spentOnJobJpy: 3, remainingJpy: 0.2, runLeftJpy: 100 })).toEqual({ ok: false, reason: "budget" });
    expect(caseBudget({ perCaseCapJpy: 25, spentOnJobJpy: 3, remainingJpy: 100, runLeftJpy: 0 })).toEqual({ ok: false, reason: "budget_run" });
    expect(caseBudget({ perCaseCapJpy: 40, spentOnJobJpy: 5, remainingJpy: 100, runLeftJpy: 100 })).toEqual({ ok: true, capJpy: 35 });
  });
});

describe("F3 上位との食い違いは根拠で調停する・追加の調査の回にも取得の余地を与える", () => {
  const regA = jo({ decision: "register", unresolvedImpact: "none", productKind: "pokemon_card" });
  const excB = jo({ decision: "exclude", unresolvedImpact: "none", rationale: "カード以外の商品と読んだ", excludeKind: "not_managed_product", productKind: "non_card_goods", fields: { exclude_reason: { value: "カード以外の商品", basis: "observed", evidenceId: "s1", quote: "拡張パック 架空の名前" } } });
  it("監査で食い違ったとき、両方の理由を渡して調停させ、根拠つきで決まれば採用する（機械的に保留にしない）", async () => {
    const issuesSeen: string[] = [];
    let n = 0;
    const upper: RegistrationJudge = async (i) => {
      n++;
      if (i.verificationIssues?.length) issuesSeen.push(...i.verificationIssues);
      return n === 1 ? excB : regA; // 1回目: 食い違い（除外）／2回目（調停）: 原文を照らして登録
    };
    const r = await runResearch({ caseId: "c", seed, agent: async () => stop, judge: async () => regA, tools: { now: () => NOW, fetchPage: async () => ({ ok: false, reason: "failed" }) }, budget: new CallBudget({ maxCalls: 30, maxCostJpy: 100 }), escalation: { judge: upper, model: "u", primaryModel: "p", auditRate: 1 } });
    expect(issuesSeen.join(" ")).toContain("reconcile");
    expect(issuesSeen.join(" ")).toContain("カード以外の商品と読んだ");
    expect(r.registration.finalDecision).toBe("register");
    expect(r.registration.held).toBeNull();
    expect(r.judgeTrail?.find((s) => s.stage === "reconciled")).toMatchObject({ adopted: true, decision: "register" });
  });
  it("1回目の調査で取得の外枠を使い切っても、追加の調査の回では新たに取得できる", async () => {
    const fetched: string[] = [];
    let k = 0;
    const agent: ResearchAgent = async () => (k++ === 0 ? fetchTurn("https://example.invalid/a") : k === 2 ? stop : k === 3 ? fetchTurn("https://example.invalid/b") : stop);
    let j = 0;
    const judge: RegistrationJudge = async () => (j++ === 0 ? jo({}) : jo({ decision: "register", unresolvedImpact: "none" }));
    await runResearch({ caseId: "c", seed, agent, judge, tools: { now: () => NOW, fetchPage: async (u) => (fetched.push(u), page(u, `ページ ${u}`)) }, budget: new CallBudget({ maxCalls: 30, maxCostJpy: 100 }), limits: { maxFetches: 1 } });
    expect(fetched).toEqual(["https://example.invalid/a", "https://example.invalid/b"]);
  });
});

describe("F4 待ち行列: 新AIの実際の完了を参照し、未調査の機会を捨てない", () => {
  const now = new Date("2026-11-28T03:00:00Z");
  it("旧方式の締切が過ぎても、新AIが未完了・新AIの締切が先なら閉じない。再開待ちは最優先", () => {
    expect(queueDecision({ status: "excluded", deadline: "2026-11-20", evaluatedBefore: true, completedByNewAi: false, newAiDeadline: null }, now)).toEqual({ action: "keep", tier: 2 });
    expect(queueDecision({ status: "excluded", deadline: "2026-11-20", evaluatedBefore: true, completedByNewAi: true, newAiDeadline: "2026-12-05" }, now)).toEqual({ action: "keep", tier: 2 });
    expect(queueDecision({ status: "excluded", deadline: "2026-11-20", evaluatedBefore: true, completedByNewAi: true, newAiDeadline: "2026-11-21" }, now)).toEqual({ action: "skip", reason: "deadline_passed" });
    expect(queueDecision({ status: "excluded", deadline: "2026-11-20", evaluatedBefore: true, completedByNewAi: true, newAiDeadline: "excluded" }, now)).toEqual({ action: "skip", reason: "deadline_passed" });
    expect(queueDecision({ status: "excluded", deadline: "2026-11-20", evaluatedBefore: true, completedByNewAi: false, continuation: true }, now)).toEqual({ action: "keep", tier: 0 });
  });
  it("新AIの完了・締切は現行の版の登録案から求める（中断した項目があれば未完了）", () => {
    const row = (o: object) => ({ candidate_id: "c", decision: "register", verified: true, end_reason: "sufficient", held_reasons: [], fields: { deadline: { value: "2026-12-01 23:59" } }, ...o });
    expect(newAiView([row({}), row({ fields: { deadline: { value: "2026-12-03" } } })])).toEqual({ completed: true, deadline: "2026-12-03" });
    expect(newAiView([row({}), row({ decision: "tentative", end_reason: "limit_time" })]).completed).toBe(false);
    expect(newAiView([row({ decision: "exclude" })])).toEqual({ completed: true, deadline: "excluded" });
    expect(newAiView([row({ fields: {} })]).deadline).toBeNull();
  });
});

// ------------------------------------------------------------------ §2 同一性
import { judgeIdentity, opportunityFromRecord, retrieveIdentityCandidates, verifyIdentity, type ExistingOpportunity, type IdentityJudge, type NewOpportunity } from "./opportunity-identity";

const ex = (o: Partial<ExistingOpportunity>): ExistingOpportunity => ({ id: "L1", kind: "lottery", chain: "架空ホビー", store: "駅前店", storeMode: "fixed", selectableStores: [], products: ["拡張パック 架空の名前"], applyStart: "2026-11-25 10:00", applyDeadline: "2026-12-01 23:59", result: null, sourceUrls: [], createdAt: "2026-11-24T00:00:00Z", humanConfirmed: false, ...o });
const nw = (o: Partial<NewOpportunity> = {}): NewOpportunity => ({ key: "k1", store: "架空ホビー駅前店", product: "拡張パック 架空の名前 BOX", applyStart: null, deadline: "2026-12-01 23:59", result: null, applyUnit: "one_form_one", urls: ["https://example.invalid/lottery/1"], rationale: "r", decision: "register", quotes: [], ...o });

describe("§2 同一性: 候補の検索は広く集めるだけ（結論は出さない）", () => {
  it("系列＋店舗・商品・URLの手がかりで集め、期間だけが近い無関係な抽選は比べない", () => {
    const list = [ex({}), ex({ id: "L2", chain: "別の店", store: "本店", products: ["サプライ"], sourceUrls: [] }), ex({ id: "L3", chain: "別の店", store: "本店", products: ["別商品"], sourceUrls: ["https://example.invalid/lottery/1"] })];
    const c = retrieveIdentityCandidates(nw(), list);
    expect(c.map((x) => x.target.id).sort()).toEqual(["L1", "L3"]);
    expect(c.find((x) => x.target.id === "L1")?.signals).toEqual(expect.arrayContaining(["store_text", "product_text", "period_close"]));
    expect(c.find((x) => x.target.id === "L3")?.signals).toContain("url");
  });
  it("選べる店舗の一覧に含まれる店舗も候補にする（選択式の抽選と、その中の1店舗の告知）", () => {
    const c = retrieveIdentityCandidates(nw({ store: "駅前店", product: "別の名前" }), [ex({ id: "S", chain: "系列", store: "応募時に店舗を選択", storeMode: "select_on_apply", selectableStores: ["駅前店", "本店"], products: ["別の名前"] })]);
    expect(c[0]?.signals).toContain("selectable_store");
  });
});

describe("§2 同一性: 判断はAI、検証は客観的な整合だけ", () => {
  const cands = retrieveIdentityCandidates(nw(), [ex({})]);
  it("照合先が候補に無い・根拠の値が事実に無いときは未検証（判断の中身は書き換えない）。人が確定した抽選の更新は人の確認", () => {
    expect(verifyIdentity({ relation: "same", targetId: "ZZ", action: "link_existing", why: "w", judgments: [] }, nw(), cands).issues).toContain("target_not_in_candidates");
    const v = verifyIdentity({ relation: "same", targetId: "L1", action: "link_existing", why: "w", judgments: [{ targetId: "L1", relation: "same", why: "w", cites: [{ side: "existing", field: "store", value: "存在しない店" }], diffs: [] }] }, nw(), cands);
    expect(v.verified).toBe(false);
    const ok = verifyIdentity({ relation: "same", targetId: "L1", action: "link_existing", why: "w", judgments: [{ targetId: "L1", relation: "same", why: "w", cites: [{ side: "existing", field: "store", value: "駅前店" }, { side: "new", field: "deadline", value: "2026-12-01 23:59" }], diffs: [] }] }, nw(), cands);
    expect(ok).toMatchObject({ verified: true, needsHuman: false });
    const human = verifyIdentity({ relation: "update", targetId: "L1", action: "update_existing", why: "w", judgments: [{ targetId: "L1", relation: "update", why: "w", cites: [{ side: "existing", field: "store", value: "駅前店" }], diffs: ["締切の延長"] }] }, nw(), retrieveIdentityCandidates(nw(), [ex({ humanConfirmed: true })]));
    expect(human.needsHuman).toBe(true);
  });
  it("候補が無ければAIを呼ばずに独立（費用0）。予算が無ければ未判断として人の確認（推測で新規にしない）", async () => {
    let called = 0;
    const judge: IdentityJudge = async () => (called++, { relation: "same", targetId: "L1", action: "link_existing", why: "w", judgments: [], costJpy: 0.2 });
    const none = await judgeIdentity({ opportunity: nw({ store: "まったく別", product: "無関係", urls: [] }), existing: [ex({})], judge, basisAt: "2026-11-25T00:00:00Z" });
    expect(none).toMatchObject({ relation: "independent", retrieved: 0, costJpy: 0 });
    expect(called).toBe(0);
    const poor = await judgeIdentity({ opportunity: nw(), existing: [ex({})], judge, budget: new CallBudget({ maxCalls: 5, maxCostJpy: 0.0001 }), reserveJpy: 1, basisAt: "2026-11-25T00:00:00Z" });
    expect(poor).toMatchObject({ relation: "unknown", needsHuman: true });
    expect(called).toBe(0);
  });
  it("登録案の項目から新しい機会を作る（値はAIの出力のまま）", () => {
    const o = opportunityFromRecord({ proposalKey: "k", decision: "register", sourceUrls: ["https://a.invalid/x"], fields: { store: { value: "店", quote: "【店】" }, product: { value: "商品", quote: null }, deadline: { value: "2026-12-01" }, apply_url: { value: "https://a.invalid/form" }, _rationale: { value: "理由" } }, pages: [{ url: "https://a.invalid/page" }] });
    expect(o).toMatchObject({ store: "店", product: "商品", deadline: "2026-12-01", rationale: "理由" });
    expect(o.urls).toEqual(["https://a.invalid/x", "https://a.invalid/form", "https://a.invalid/page"]);
    expect(o.quotes).toEqual([{ field: "store", quote: "【店】" }]);
  });
});
