// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AgentLLM, LlmStep } from "@/lib/agent/core";
import { comparePair } from "@/lib/agent/lottery-grouping/compare";
import { item, mkLottery, mkWorld, PRODUCT_A } from "@/lib/agent/lottery-grouping/fixtures";
import { GROUPING_SUBMIT, GROUPING_SUBMIT_STRICT_SCHEMA, parseGroupingProposal, parseGroupingProposalDetailed } from "@/lib/agent/lottery-grouping/proposal";
import { RecordingLlm, redact, sanitize } from "@/lib/agent/lottery-grouping/recorder";
import { evaluateGrouping } from "@/lib/agent/lottery-grouping/run";
import { verifyProposal } from "@/lib/agent/lottery-grouping/verify";
import { AnthropicAgentLLM } from "@/lib/agent/anthropic";

/** Stage 8F-3: 提出の形式（原因の記録・安全な補正・再提出）と、「異なる／記載なし／確認できない」の区別 */
const usage = { inputTokens: 100, outputTokens: 50, costJpy: 0 };
const final = (output: unknown): LlmStep => ({ kind: "final", output, usage, stopReason: "tool_use" });
const claimOf = (over: Record<string, unknown> = {}) => ({ action: "new_group" as const, groupId: null, memberIds: [] as string[], title: "", rationale: "", claimedCommon: [] as string[], claimedDiffers: [] as string[], commonPhrase: null, selfConfidence: 90, missing: [] as string[], ...over });

describe("提出の解析: 軽微なずれは直して受理し、判断に関わるずれだけ却下する。原因を記録する", () => {
  it("長すぎる項目（8F-2 の形式不正の有力な原因: 共通/相違の項目は40文字以内）は、切り詰めて受理し、記録する", () => {
    const long = "応募開始日時が全件で異なり（対象は2026-11-04 10:00、候補は別の日時）判断できない";
    expect(long.length).toBeGreaterThan(40);
    const r = parseGroupingProposalDetailed({ action: "single", rationale: "x", claimedDiffers: [long], missing: Array(15).fill("あ") });
    expect(r.proposal?.action).toBe("single");
    expect(r.proposal?.claimedDiffers[0].length).toBe(40);
    expect(r.proposal?.missing.length).toBe(10);
    expect(r.issues.every((i) => i.code === "repaired")).toBe(true);
    expect(r.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["claimedDiffers", "missing"]));
  });
  it("型のずれ（文字列の数値・配列でない・null）を安全に補正する。action が不正なら却下", () => {
    const r = parseGroupingProposalDetailed({ action: "new_group", memberIds: "a", selfConfidence: "85", rationale: 5, groupId: 7, claimedCommon: [1, "商品"] });
    expect(r.proposal?.selfConfidence).toBe(85);
    expect(r.proposal?.memberIds).toEqual([]);
    expect(r.proposal?.claimedCommon).toEqual(["商品"]);
    expect(parseGroupingProposalDetailed({ action: "merge_everything" })).toMatchObject({ proposal: null, issues: [{ path: "action", code: "invalid" }] });
    expect(parseGroupingProposalDetailed("text").proposal).toBeNull();
    expect(parseGroupingProposalDetailed({ action: "new_group", memberIds: Array(81).fill("x") }).proposal).toBeNull(); // 過大な件数は却下（従来どおり）
  });
  it("共通の文言が300字を超えるときは切り詰めず、無しとする（切り詰めると『実在する文言』の検証の意味が変わるため）", () => {
    const r = parseGroupingProposalDetailed({ action: "new_group", memberIds: ["a"], commonPhrase: "あ".repeat(301) });
    expect(r.proposal?.commonPhrase).toBeNull();
    expect(parseGroupingProposal({ action: "new_group", commonPhrase: "冬の検証企画　抽選販売" })?.commonPhrase).toBe("冬の検証企画　抽選販売");
  });
  it("補正しても安全性は変わらない: 切り詰めた提出も検証層を通り、期間が異なれば自動にならない", () => {
    const s = mkLottery({ applyDeadline: { precision: "date_only", date: "2026-12-07" } });
    const a = mkLottery({ applyDeadline: { precision: "date_only", date: "2026-12-20" } });
    const claim = parseGroupingProposal({ action: "new_group", memberIds: [a.id], rationale: "同じ", claimedCommon: ["応募期間が共通であると判断した（とても長い文字列がここに続きます）"], commonPhrase: null })!;
    expect(verifyProposal(mkWorld(s, [a]), claim, { allowAuto: true }).tier).not.toBe("auto");
  });
});

describe("形式不正時: 1回だけ再提出を促し、直らなければ保留（自動にしない）", () => {
  const s = mkLottery({ n: 1 });
  const a = mkLottery({ n: 2 });
  const world = () => mkWorld(s, [a]);
  it("不正→再提出で有効になれば、その判断を検証して採用する。再提出の記録が残る", async () => {
    let calls = 0;
    const llm: AgentLLM = { name: "t", async step() { calls++; return calls === 1 ? final({ action: "group_all" }) : final({ action: "single", rationale: "同じ企画の根拠がない" }); } };
    const o = await evaluateGrouping(world(), { llm, allowAuto: true });
    expect(o.decision.tier).toBe("single");
    expect(o.followUps).toEqual([expect.objectContaining({ kind: "format" })]);
    expect(o.firstClaim).toBeNull(); // 最初の提出は不正だった
    expect(calls).toBe(2);
  });
  it("再提出しても不正なら、保留。自動グループ化は起きない。再提出は1回だけ（無限ループしない）", async () => {
    let calls = 0;
    const llm: AgentLLM = { name: "t", async step() { calls++; return final({ action: "nonsense" }); } };
    const o = await evaluateGrouping(world(), { llm, allowAuto: true });
    expect(o.decision.tier).toBe("hold");
    expect(o.decision.downgrades).toContain("AIの提出が不正");
    expect(o.parseIssues[0]).toMatchObject({ code: "invalid" });
    expect(calls).toBe(2);
    let calls2 = 0;
    const none = await evaluateGrouping(world(), { llm: { name: "t", async step() { calls2++; return final({ action: "x" }); } }, allowAuto: true, formatRepairs: 0 });
    expect(none.decision.tier).toBe("hold");
    expect(calls2).toBe(1);
  });
  it("再提出の指摘は、形式の理由だけ（正解・内部情報を含まない）", async () => {
    const seen: string[] = [];
    const llm: AgentLLM = { name: "t", async step({ messages }) { seen.push(JSON.stringify(messages)); return seen.length === 1 ? final({ action: "zzz" }) : final({ action: "hold", rationale: "確認できない" }); } };
    await evaluateGrouping(world(), { llm, allowAuto: true });
    expect(seen[1]).toContain("提出の形式が不正");
    expect(seen[1]).not.toMatch(/gold|basis/);
  });
});

describe("異なる／記載なし／確認できない の区別", () => {
  it("応募条件: 一方にだけ記載のある項目（記載なし）は『食い違い』ではなく unstated。互いに相手に無い項目があれば differs", () => {
    const base = { conditionsText: "会員限定" };
    const a = mkLottery({ ...base, requirementTags: ["member"] });
    const b = mkLottery({ ...base, requirementTags: ["member", "id_check"] });
    const c = mkLottery({ ...base, requirementTags: ["member", "photo_id"] });
    expect(comparePair(a, b).requirements).toBe("unstated");
    expect(comparePair(b, c).requirements).toBe("differs");
    expect(comparePair(a, mkLottery({ ...base, requirementTags: ["member"] })).requirements).toBe("same");
  });
  it("unstated は軽微（soft）扱い: 他の項目がそろい、同じ企画の裏づけがあれば候補（review）。自動にはしない。理由に『記載なし』が出る", () => {
    const s = mkLottery({ requirementTags: ["member"], sourceUrls: ["https://example.invalid/e/shared1"] });
    const a = mkLottery({ requirementTags: ["member", "id_check"], sourceUrls: ["https://example.invalid/e/shared1"] });
    const d = verifyProposal(mkWorld(s, [a]), claimOf({ memberIds: [a.id], rationale: "同じ" }), { allowAuto: true });
    expect(d.tier).toBe("suggest");
    expect(d.mismatches.some((m) => m.field === "requirements" && m.severity === "soft" && m.detail.includes("記載なし"))).toBe(true);
    expect(d.rationale).toContain("記載なし");
  });
  it("『異なる』（応募期間が別）で同じ企画の裏づけが無ければ single のまま（まとめない）。『記載なし』の緩和は、期間の相違には及ばない", () => {
    const s = mkLottery({ applyDeadline: { precision: "date_only", date: "2026-12-07" } });
    const a = mkLottery({ applyDeadline: { precision: "date_only", date: "2026-12-20" } });
    expect(verifyProposal(mkWorld(s, [a]), claimOf({ memberIds: [a.id], selfConfidence: 99 }), { allowAuto: true }).tier).toBe("single");
  });
  it("『確認できない』: 不明（日付なし）で裏づけが無ければ保留のまま（記載がないだけを根拠にまとめない）", () => {
    const s = mkLottery({ resultDate: { precision: "unknown" } });
    const a = mkLottery({ resultDate: { precision: "unknown" } });
    expect(verifyProposal(mkWorld(s, [a]), claimOf({ memberIds: [a.id], selfConfidence: 99 }), { allowAuto: true }).tier).toBe("hold");
  });
  it("AIに渡す情報: 情報源の文章が保存されているか（sourceTextStored）と、関係の読み方（legend）が含まれる", async () => {
    const { buildGroupingTools } = await import("@/lib/agent/lottery-grouping/tools");
    const s = mkLottery({ n: 1, items: [item(PRODUCT_A, 1)] });
    const a = mkLottery({ n: 2, items: [item(PRODUCT_A, 1)] });
    const reg = buildGroupingTools(mkWorld(s, [a], { evidence: { [s.id]: ["本文"] } }));
    const run = async (name: string) => JSON.parse((await reg.get(name)!.run({} as never, undefined as never)).content);
    expect((await run("get_subject")).sourceTextStored).toBe(true);
    const rel = await run("list_related_lotteries");
    expect(rel.legend).toContain("記載がない");
    expect(rel.lotteries[0].sourceTextStored).toBe(false);
  });
});

describe("実APIの応答の記録: 伏せ字・切り詰め。キーを残さない", () => {
  it("キーらしき文字列と認証系のキーを伏せる。長い文章は切り詰める", () => {
    expect(redact("error sk-ant-api03-ABCDEFGHIJ1234 and Bearer abcdefghijklmnop")).not.toMatch(/ABCDEFGHIJ|abcdefghijklmnop/);
    const s = sanitize({ action: "single", rationale: "あ".repeat(5000), headers: { "x-api-key": "sk-ant-SECRET0000", authorization: "Bearer zzzzzzzzzzzz" }, nested: { apiKey: "k" } }) as Record<string, unknown>;
    expect(JSON.stringify(s)).not.toMatch(/SECRET0000|zzzzzzzzzzzz/);
    expect((s.rationale as string).length).toBeLessThanOrEqual(1500);
    expect((s.headers as Record<string, string>)["x-api-key"]).toBe("[伏せ字]");
  });
  it("RecordingLlm: 各ステップの停止理由・呼んだツール・提出の生の内容・エラーを残す（キーは伏せる）", async () => {
    const inner: AgentLLM = { name: "t", step: async () => ({ kind: "final", output: { action: "x", note: "sk-ant-SECRET9999999" }, usage, stopReason: "end_turn:no_tool_call" }) };
    const rec = new RecordingLlm(inner);
    await rec.step({ system: "", messages: [], tools: [] });
    expect(rec.steps[0]).toMatchObject({ kind: "final", stopReason: "end_turn:no_tool_call" });
    expect(JSON.stringify(rec.steps)).not.toContain("SECRET9999999");
    const bad = new RecordingLlm({ name: "t", step: async () => { throw new Error("401 sk-ant-LEAK1234567"); } });
    await expect(bad.step({ system: "", messages: [], tools: [] })).rejects.toThrow();
    expect(JSON.stringify(bad.steps)).not.toContain("LEAK1234567");
    expect(bad.steps[0].kind).toBe("error");
  });
});

describe("構造化（strict）の提出ツール: 既定は無効。有効にしたときだけ strict と追加プロパティ禁止を送る", () => {
  const make = (strict: boolean | undefined) => {
    const sent: { tools: { name: string; strict?: boolean }[] }[] = [];
    const client = { messages: { create: async (p: never) => { sent.push(p); return { content: [{ type: "tool_use", id: "1", name: "submit_findings", input: { action: "single", rationale: "x" } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }; } } };
    const llm = new AnthropicAgentLLM(client as never, "claude-haiku-5-5", { submit: { description: GROUPING_SUBMIT.description, schema: (strict ? GROUPING_SUBMIT_STRICT_SCHEMA : GROUPING_SUBMIT.schema) as never, emptyOutput: GROUPING_SUBMIT.emptyOutput, strict } });
    return { llm, sent };
  };
  it("strict=false/未指定では strict を送らない／true では送る", async () => {
    for (const [flag, expected] of [[undefined, undefined], [false, undefined], [true, true]] as const) {
      const { llm, sent } = make(flag);
      const r = await llm.step({ system: "s", messages: [{ role: "user", text: "t" }], tools: [] });
      expect(sent[0].tools.find((t) => t.name === "submit_findings")?.strict).toBe(expected);
      expect(r.kind === "final" && r.stopReason).toBe("tool_use");
    }
    expect((GROUPING_SUBMIT_STRICT_SCHEMA as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });
});
