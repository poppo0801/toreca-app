// @vitest-environment node
/** Stage 10U: AIアダプタの安全性（偽のクライアント。実AIは呼ばない）。ツールは「結果の提出」1つだけ・読み取り専用・命令はデータ・秘密を渡さない。 */
import { describe, expect, it, vi } from "vitest";
import { makeAnthropicRegistrationJudge, makeAnthropicResearchAgent, normalizeFields, strictifySchema, withStrictTools, JUDGE_SYSTEM, RESEARCH_SYSTEM, renderJudgeInput, renderTurnInput } from "./research-ai";

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
    expect(seen.map((d) => d.reason)).toEqual(["api_error:429", "api_error:429", expect.stringMatching(/^bad_output:/), "retry_bad_output", expect.stringMatching(/^bad_output:/), "retry_failed"]); // 形の不備は1回だけ再試行する
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

describe("判断のAI: 項目数の上限", () => {
  it("上限（12項目）を超えた項目は保存されず、黙って捨てずに診断（fields_truncated）へ記録する", async () => {
    const fields = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, { value: `v${i}`, basis: "inferred" }]));
    const { client } = fake({ decision: "tentative", fields, rationale: "r", unresolvedImpact: "minor", monitor: { continue: true, why: "w" } });
    const diags: string[] = [];
    const out = await makeAnthropicRegistrationJudge(client, { onDiagnostic: (d) => diags.push(d.reason) })({ caseId: "c1", evidence: [view], lastTurn: null, investigationEnd: "sufficient", protectedFields: {} });
    expect(Object.keys(out?.fields ?? {})).toHaveLength(12);
    expect(diags).toContain("fields_truncated");
  });
});

describe("判断出力の形式の揺れ（Phase 3 RUNTIME_PARITY。本番で、ページを読んだ後に fields が文字列で返る不備を確認した場合に備える）", () => {
  const input = { caseId: "c1", evidence: [view], lastTurn: null, investigationEnd: "sufficient" as const, protectedFields: {} };
  it("fields が JSON 文字列で返されたときは一度だけ解釈して採用する（内容の検証は従来どおり）。解釈できない・配列は不備として、型だけを記録する", async () => {
    const seen: string[] = [];
    const onDiagnostic = (d: { role: string; reason: string }) => seen.push(d.reason);
    const ok = await makeAnthropicRegistrationJudge(fake({ decision: "tentative", fields: JSON.stringify({ store: { value: "A店", basis: "unknown" } }), rationale: "x", unresolvedImpact: "minor", monitor: { continue: true, why: "w" } }).client, { onDiagnostic })(input);
    expect(ok?.decision).toBe("tentative");
    expect(Object.keys(ok?.fields ?? {})).toEqual(["store"]);
    expect(seen).toEqual([]);
    const bad = await makeAnthropicRegistrationJudge(fake({ decision: "tentative", fields: "not json {" }).client, { onDiagnostic })(input);
    const arr = await makeAnthropicRegistrationJudge(fake({ decision: "tentative", fields: [1] }).client, { onDiagnostic })(input);
    const dec = await makeAnthropicRegistrationJudge(fake({ decision: "maybe", fields: {} }).client, { onDiagnostic })(input);
    expect([bad, arr, dec]).toEqual([null, null, null]);
    expect(seen.filter((r) => r.startsWith("bad_output:")).map((r) => r.replace(/^bad_output:[^:]*:/, ""))).toEqual(["fields_string_text_LS_K2", "fields_string_text_LS_K2", "fields_array", "fields_array", "decision_string", "decision_string"]); // 各1回ずつ再試行（同じ不備）
    expect(seen.filter((r) => r === "retry_failed")).toHaveLength(3);
  });
});

describe("取得元ページの扱い（Phase 3 RUNTIME_PARITY。台本のクライアントでは検出できない、AIへの指示そのものの契約）", () => {
  it("調査AIの指示は、『収集時の取得元ページ』を、応募先URLとは別の手掛かりとして、検索の可否にかかわらず先に取得して確認してよいと明示する。取得元ページだけで応募先・応募単位を確定しない", () => {
    expect(RESEARCH_SYSTEM).toContain("収集時の取得元ページ");
    expect(RESEARCH_SYSTEM).toContain("応募先URLとは別の意味");
    expect(RESEARCH_SYSTEM).toContain("検索の可否にかかわらず、まずそのページを取得して確認してよい");
    expect(RESEARCH_SYSTEM).toContain("取得元ページがあることだけで、応募先や応募単位を確定しない");
    // 「検索が使えないときだけ到達不能」の規則は、取得元ページがある場合の例外を持つ（取得元ページがあるのに取得せず終了しない）
    expect(RESEARCH_SYSTEM).toContain("3dの「収集時の取得元ページ」が与えられているときは、先にそれを取得して確認する");
  });
  it("プロンプト版は、この変更（取得元ページの扱い）で上がっている（版別に比較できる）", async () => {
    const { PROPOSAL_PROMPT_VERSION } = await import("./proposal");
    expect(PROPOSAL_PROMPT_VERSION).toBe("10z-8");
  });
});

describe("応募先の推定・店舗選択式の明記（Phase 3 THREE_CASE。AIへの指示の契約）", () => {
  it("判断の指示は、店舗選択式の明記と、応募ボタンの遷移先として取得された取得元ページの応募先推定を、基準として持つ。調査の指示も同じ例外を持つ", () => {
    expect(JUDGE_SYSTEM).toContain("対象店舗の中から1店舗のみ応募可能");
    expect(JUDGE_SYSTEM).toContain("応募ボタン");
    expect(JUDGE_SYSTEM).toContain("応募先が推定できることは、応募単位の確定とは別");
    expect(RESEARCH_SYSTEM).toContain("応募先と推定してよい");
  });
});

describe("出力の安定化（Phase 3 FOUNDATION_RECOVERY）", () => {
  const input = { caseId: "c1", evidence: [view], lastTurn: null, investigationEnd: "sufficient" as const, protectedFields: {} };
  const ok = { decision: "tentative", rationale: "x", unresolvedImpact: "minor", monitor: { continue: true, why: "w" } };
  it("fields が {name,...} の配列（現行スキーマ）・配列を文字列にしたもの・従来のオブジェクトのいずれでも同じ結果になる。名前なし・重複は解釈しない", async () => {
    const f = [{ name: "store", value: "A店", basis: "unknown" }];
    const a = await makeAnthropicRegistrationJudge(fake({ ...ok, fields: f }).client)(input);
    const b = await makeAnthropicRegistrationJudge(fake({ ...ok, fields: JSON.stringify(f) }).client)(input);
    const c = await makeAnthropicRegistrationJudge(fake({ ...ok, fields: { store: { value: "A店", basis: "unknown" } } }).client)(input);
    expect([a, b, c].map((x) => JSON.stringify(x?.fields))).toEqual([JSON.stringify(a?.fields), JSON.stringify(a?.fields), JSON.stringify(a?.fields)]);
    expect(Object.keys(a?.fields ?? {})).toEqual(["store"]);
    expect(normalizeFields({ fields: [{ value: "x" }] }).fields).toEqual([{ value: "x" }]);
    expect(normalizeFields({ fields: [{ name: "s", value: "1" }, { name: "s", value: "2" }] }).fields).toEqual([{ name: "s", value: "1" }, { name: "s", value: "2" }]);
  });
  it("形の不備は同じ入力で1回だけ再試行し、成功すれば採用する（失敗した試行は記録する）。途中切れ（max_tokens）は再試行しない。壊れたJSONは補完しない", async () => {
    const seen: string[] = [];
    let n = 0;
    const client = { messages: { create: vi.fn(async (req: { tool_choice: { name: string } }) => (n++ === 0 ? { stop_reason: "tool_use", content: [{ type: "tool_use", name: req.tool_choice.name, input: { ...ok, fields: "{broken" } }], usage: { input_tokens: 100, output_tokens: 10 } } : { stop_reason: "tool_use", content: [{ type: "tool_use", name: req.tool_choice.name, input: { ...ok, fields: [] } }], usage: { input_tokens: 100, output_tokens: 10 } })) } } as never;
    const out = await makeAnthropicRegistrationJudge(client, { onDiagnostic: (d) => seen.push(d.reason) })(input);
    expect(out?.decision).toBe("tentative");
    expect(n).toBe(2);
    expect(seen).toEqual(["bad_output:tool_use:fields_string_obj_LS_K5", "retry_bad_output", "retry_recovered"]);
    let m = 0;
    const cut = { messages: { create: vi.fn(async () => (m++, { stop_reason: "max_tokens", content: [{ type: "tool_use", name: "submit_registration_judgment", input: { decision: "maybe" } }], usage: { input_tokens: 1, output_tokens: 1 } })) } } as never;
    expect(await makeAnthropicRegistrationJudge(cut, { strict: false })(input)).toBeNull();
    expect(m).toBe(1);
  });
  it("厳密なツール入力（strict）で呼ぶ。プロバイダが400で拒否したら、通常のツール入力で呼び直し、以降は通常のまま。診断に残す", async () => {
    const reqs: { tools: { strict?: boolean }[] }[] = [];
    const seen: string[] = [];
    const client = { messages: { create: vi.fn(async (req: { tools: { strict?: boolean }[]; tool_choice: { name: string } }) => { reqs.push(req); if (req.tools[0].strict) throw Object.assign(new Error("schema"), { status: 400 }); return { stop_reason: "tool_use", content: [{ type: "tool_use", name: req.tool_choice.name, input: { ...ok, fields: [] } }], usage: { input_tokens: 10, output_tokens: 5 } }; }) } } as never;
    const judge = makeAnthropicRegistrationJudge(client, { onDiagnostic: (d) => seen.push(d.reason) });
    expect((await judge(input))?.decision).toBe("tentative");
    expect((await judge(input))?.decision).toBe("tentative");
    expect(reqs.map((r) => !!r.tools[0].strict)).toEqual([true, false, false]);
    expect(seen).toEqual(["strict_rejected"]);
    const direct = fake({ ...ok, fields: [] });
    await makeAnthropicRegistrationJudge(direct.client)(input);
    expect((direct.calls[0] as { tools: { strict?: boolean }[] }).tools[0].strict).toBe(true);
    expect(withStrictTools).toBeTypeOf("function");
  });
  it("strict用のスキーマ: 長さ・件数の制約を除き、全オブジェクトを additionalProperties:false にし、型の配列を anyOf にする。元のスキーマは壊さない", () => {
    const src = { type: "object", properties: { a: { type: ["string", "null"], maxLength: 5 }, b: { type: "array", maxItems: 2, items: { type: "object", properties: { c: { type: "string" } }, required: ["c"] } } }, required: ["a"] };
    const out = strictifySchema(src) as { additionalProperties: boolean; properties: { a: { anyOf: unknown[]; maxLength?: number }; b: { maxItems?: number; items: { additionalProperties: boolean } } } };
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.a.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    expect(out.properties.a.maxLength).toBeUndefined();
    expect(out.properties.b.maxItems).toBeUndefined();
    expect(out.properties.b.items.additionalProperties).toBe(false);
    expect((src.properties.a as { maxLength: number }).maxLength).toBe(5);
  });
});

describe("応募単位とお1人様の上限の分離（Phase 3 FOUNDATION_RECOVERY）", () => {
  it("判断の指示は、応募単位（受付枠の構造）とお1人様の上限（口数）を別の事実として扱い、上限が書かれていないことを理由に暫定にしない・値を捏造しない・未記載を『上限なし』としない", () => {
    expect(JUDGE_SYSTEM).toContain("応募単位は「応募の機会の構造」");
    expect(JUDGE_SYSTEM).toContain("per_person_limit");
    expect(JUDGE_SYSTEM).toContain("書かれていないことは「上限なし」ではない");
    expect(JUDGE_SYSTEM).toContain("それだけを理由に暫定にしない");
    expect(JUDGE_SYSTEM).toContain("受付枠が複数ある・構造が読み取れない場合は従来どおり");
  });
});
