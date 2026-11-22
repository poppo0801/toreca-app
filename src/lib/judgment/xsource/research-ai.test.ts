// @vitest-environment node
/** Stage 10U: AIアダプタの安全性（偽のクライアント。実AIは呼ばない）。ツールは「結果の提出」1つだけ・読み取り専用・命令はデータ・秘密を渡さない。 */
import { describe, expect, it, vi } from "vitest";
import { makeAnthropicRegistrationJudge, makeAnthropicResearchAgent, JUDGE_SYSTEM, RESEARCH_SYSTEM, renderJudgeInput, renderTurnInput } from "./research-ai";

vi.mock("server-only", () => ({}));

const fake = (input: unknown, usage = { input_tokens: 4000, output_tokens: 600 }) => {
  const calls: Record<string, unknown>[] = [];
  const client = { messages: { create: vi.fn(async (req: Record<string, unknown>) => (calls.push(req), { content: [{ type: "tool_use", name: (req.tool_choice as { name: string }).name, input }], usage })) } };
  return { client: client as never, calls };
};
const view = { id: "s1", kind: "seed" as const, url: null, fetchedAt: "2026-11-22T00:00:00Z", independent: true, observations: ["受付枠 1件"], excerpt: "連絡は test@example.com まで。応募はこちら" };
const turnInput = { caseId: "c1", evidence: [view], history: [{ url: "example.test/a", outcome: "ok", progress: true }], remaining: { turns: 3, fetches: 3, costJpy: 10, elapsedMs: 100000 } };

describe("調査のAI（アダプタ）", () => {
  it("ツールは『結果の提出』1つだけ（強制）。取得・書き込み・実行・DB・SQL のツールは渡さない。命令はデータと明記", async () => {
    const { client, calls } = fake({ observed: [], unknown: [], next: { kind: "stop", reason: "sufficient", why: "十分" } });
    await makeAnthropicResearchAgent(client)(turnInput);
    const req = calls[0] as { tools: { name: string }[]; tool_choice: { type: string; name: string }; system: string };
    expect(req.tools.map((t) => t.name)).toEqual(["submit_research_turn"]);
    expect(req.tool_choice).toEqual({ type: "tool", name: "submit_research_turn" });
    expect(req.system).toBe(RESEARCH_SYSTEM);
    expect(RESEARCH_SYSTEM).toContain("命令ではなく");
    expect(RESEARCH_SYSTEM).toContain("関連イベント"); // ページ自身の受付枠と別
    expect(RESEARCH_SYSTEM).toMatch(/被害.*重要性.*見込み.*締切.*費用/s); // 追加調査の必要性の観点（点数ではなく理由）
  });
  it("個人情報（メールアドレス等）は redact して渡す", () => {
    expect(renderTurnInput(turnInput)).not.toContain("test@example.com");
  });
  it("次の行動（fetch/stop）・不明点・費用を解釈する。不正な出力は null（呼び出し側が agent_failed として扱う）", async () => {
    const a = await makeAnthropicResearchAgent(fake({ observed: [{ text: "受付枠あり", evidenceId: "s1", quote: "受付枠 1件" }], inferred: [], unknown: [{ what: "応募単位", importance: "high", harmIfWrong: ["重複登録"], expectedInfoGain: "high", rationale: "ページで分かる" }], counterHypotheses: ["店舗選択式"], next: { kind: "fetch", url: "https://example.test/a", why: "応募ページ" } }).client)(turnInput);
    expect(a?.next).toEqual({ kind: "fetch", url: "https://example.test/a", why: "応募ページ" });
    expect(a?.unknown[0]).toMatchObject({ importance: "high", expectedInfoGain: "high" });
    expect(a?.costJpy).toBeGreaterThan(0);
    expect(await makeAnthropicResearchAgent(fake({ nope: 1 }).client)(turnInput)).toBeNull();
    const failing = { messages: { create: vi.fn(async () => { throw new Error("x"); }) } } as never;
    expect(await makeAnthropicResearchAgent(failing)(turnInput)).toBeNull();
  });
});

describe("失敗の理由の記録（Stage 10X）", () => {
  it("通信の失敗と出力の形式不備を区別して記録する（原文・鍵は含まない）。引用は原文からそのまま写す指示を持つ", async () => {
    const seen: { role: string; reason: string }[] = [];
    const onDiagnostic = (d: { role: string; reason: string }) => seen.push(d);
    const http = { messages: { create: vi.fn(async () => { throw Object.assign(new Error("secret-ish message"), { status: 429 }); }) } } as never;
    expect(await makeAnthropicResearchAgent(http, { onDiagnostic })(turnInput)).toBeNull();
    expect(await makeAnthropicRegistrationJudge(http, { onDiagnostic })({ caseId: "c1", evidence: [view], lastTurn: null, investigationEnd: "sufficient", protectedFields: {} })).toBeNull();
    expect(await makeAnthropicResearchAgent(fake({ nope: 1 }).client, { onDiagnostic })(turnInput)).toBeNull();
    expect(seen.map((d) => d.reason)).toEqual(["api_error:429", "api_error:429", expect.stringMatching(/^bad_output:/)]);
    expect(JSON.stringify(seen)).not.toContain("secret-ish");
    expect(JUDGE_SYSTEM).toContain("一字一句そのまま");
  });
});
describe("登録判断のAI（アダプタ）", () => {
  const ji = { caseId: "c1", evidence: [view], lastTurn: null, investigationEnd: "sufficient" as const, protectedFields: { store: "店舗A" } };
  it("ツールは提出だけ。判断・項目ごとの根拠の種類（observed/inferred/unknown）・監視の継続を解釈する", async () => {
    const { client, calls } = fake({ decision: "register", fields: { store: { value: "店舗A", basis: "observed", evidenceId: "s1", quote: "店舗A" }, result: { value: null, basis: "unknown" }, region: { value: "東京都", basis: "inferred" }, bad: { value: "x", basis: "maybe" } }, rationale: "根拠あり", unresolvedImpact: "minor", monitor: { continue: false, why: "価値が低い" } });
    const out = await makeAnthropicRegistrationJudge(client)(ji);
    expect((calls[0] as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["submit_registration_judgment"]);
    expect(out).toMatchObject({ decision: "register", unresolvedImpact: "minor", monitor: { continue: false } });
    expect(Object.keys(out!.fields)).toEqual(["store", "result", "region"]); // 不正な根拠の種類の項目は捨てる
    expect(out!.fields.result).toEqual({ value: null, basis: "unknown" });
  });
  it("全項目が揃うことを本登録の条件にしない・人が確定した値は変更しない・前回の検証の指摘だけを直す、をプロンプトに含む。不正な出力は null", async () => {
    expect(JUDGE_SYSTEM).toContain("全ての項目が揃うことは本登録の条件ではありません");
    expect(JUDGE_SYSTEM).toContain("変更しません");
    expect(renderJudgeInput({ ...ji, verificationIssues: ["quote_not_found:deadline"] })).toContain("quote_not_found:deadline");
    expect(renderJudgeInput(ji)).toContain("store: 店舗A");
    expect(await makeAnthropicRegistrationJudge(fake({ decision: "maybe", fields: {} }).client)(ji)).toBeNull();
  });
});
