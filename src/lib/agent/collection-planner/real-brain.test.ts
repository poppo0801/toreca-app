import { describe, expect, it } from "vitest";
import { resolveControls } from "@/lib/agent/collection-planner/controls";
import { executeInvestigation } from "@/lib/agent/collection-planner/executor";
import { buildReviewFeedback } from "@/lib/agent/collection-planner/review";
import { createRealBrain, INVESTIGATION_SYSTEM, PLAN_SUBMIT_SCHEMA } from "@/lib/agent/collection-planner/real-brain";
import type { AnalysisPreview, InvestigationSignals, PageData, PlannerWorld } from "@/lib/agent/collection-planner/types";
import type { AgentLLM, AgentMessage, LlmStep } from "@/lib/agent/core";

/** Stage 9E: 実AI（Claude）の頭脳の接続の安全性。実APIは使わない（スクリプト化したAI・偽のクライアントで検証） */
const signals: InvestigationSignals = {
  today: "2026-11-14",
  releases: [],
  chains: [{ id: "c1", name: "テスト玩具", storeCount: 3, lotteries30d: 0, monitored: false, officialUrl: "https://toy.example.invalid/" }],
  missing: [],
  failed: [],
  monitors: [],
  discovery: { found7d: 0, registered7d: 0, held7d: 0 },
};
const PAGES: Record<string, { title: string; text: string; links?: { url: string; text: string }[] }> = {
  "https://toy.example.invalid/": { title: "テスト玩具 公式", text: "お知らせ一覧", links: [{ url: "https://toy.example.invalid/n/1", text: "ハドウシーカー 抽選販売のお知らせ" }] },
  "https://toy.example.invalid/n/1": { title: "ハドウシーカー 抽選販売のお知らせ", text: "ハドウシーカー 抽選販売のお知らせ 応募期間 11/16〜11/20" },
};
const analyze = async (page: PageData): Promise<AnalysisPreview> => {
  const lottery = /抽選販売のお知らせ/.test(page.title);
  return { url: page.url, pageKind: lottery ? "lottery_announcement" : "announcement_index", recognized: lottery, chainName: "テスト玩具", storeName: "", products: lottery ? ["ハドウシーカー"] : [], applyDeadline: lottery ? "2026-11-20" : null, missing: [], disposition: { kind: lottery ? "new" : "investigate", targetLotteryId: null, reason: "テスト" }, registrable: false, blockers: [], costJpy: 0 };
};
const world = (): PlannerWorld => ({
  signals: async () => signals,
  fetchPage: async (url) => (PAGES[url] ? { ok: true, ...PAGES[url] } : { ok: false, reason: "なし" }),
  analyze,
  matchExisting: async () => [],
});
const controls = () => {
  const d = resolveControls({ runsToday: 0, costTodayJpy: 0, workerDailyAiLimit: 30, aiCallsToday: 0 }, { mode: "dry_run", realApi: true });
  if (!d.ok) throw new Error(d.reason);
  return { ...d.controls, throttle: { ...d.controls.throttle, minIntervalMs: 0 } };
};
const u = { inputTokens: 100, outputTokens: 50, costJpy: 0.01 };
const SUBMIT = "submit_findings";

/** スクリプト化したAI: 一覧を取得して「告知の一覧を抽選の告知」と誤って提出する→検証の指摘を受けて、リンクをたどり、訂正して再提出する */
class ScriptedAi implements AgentLLM {
  readonly name = "anthropic:scripted";
  private n = 0;
  readonly seenSystem: string[] = [];
  async step({ system, messages }: { system: string; messages: AgentMessage[] }): Promise<LlmStep> {
    this.seenSystem.push(system);
    this.n += 1;
    const id = `t${this.n}`;
    const toolMsgs = messages.filter((m) => m.role === "tool").length;
    if (this.n === 1) return { kind: "tool_calls", calls: [{ id, name: "check_official_site", input: { url: "https://toy.example.invalid/", purpose: "公式サイトを確認" } }], text: "公式サイトを確認します", usage: u };
    if (this.n === 2) return { kind: "tool_calls", calls: [{ id, name: "analyze_page_for_lottery", input: { url: "https://toy.example.invalid/", purpose: "解析" } }], usage: u };
    if (this.n === 3)
      return { kind: "final", usage: u, output: { tasks: [], findings: [{ kind: "lottery_info", targetId: "c1", title: "テスト玩具の抽選", url: "https://toy.example.invalid/", evidence: "お知らせ一覧", official: true, pageKind: "lottery_announcement", action: "new" }], summary: "一覧を抽選と判断" } };
    if (this.n === 4) return { kind: "tool_calls", calls: [{ id, name: "follow_external_link", input: { url: "https://toy.example.invalid/n/1", purpose: "検証の指摘: 個別の告知を確認" } }], text: "検証の指摘を受けて、個別の告知を確認します", usage: u };
    if (this.n === 5) return { kind: "tool_calls", calls: [{ id, name: "analyze_page_for_lottery", input: { url: "https://toy.example.invalid/n/1", purpose: "解析" } }], usage: u };
    void toolMsgs;
    return { kind: "final", usage: u, output: { tasks: [], findings: [{ kind: "lottery_info", targetId: "c1", title: "ハドウシーカー抽選", url: "https://toy.example.invalid/n/1", evidence: "応募期間 11/16〜11/20", official: true, pageKind: "lottery_announcement", action: "new" }], summary: "個別の告知を確認" } };
  }
}

describe("実AIの頭脳の接続（スクリプト化したAIで検証）", () => {
  it("AIの判断と固定ロジックの食い違い・未確認のリンクは、検証が具体的に指摘し、AIは追加調査を選べる。決めたのが誰かが記録される", async () => {
    const ai = new ScriptedAi();
    const r = await executeInvestigation({ llm: ai, world: world(), controls: controls(), sleep: async () => {}, system: INVESTIGATION_SYSTEM, maxReviews: 1 });
    expect(r.status).toBe("completed");
    expect(r.followUps).toBe(1);
    // 最初の提出（一覧を抽選と判断）は検証の指摘を受け、リンクをたどって訂正された
    const follow = r.steps.find((s) => s.tool === "follow_external_link");
    expect(follow?.decidedBy).toBe("review_feedback");
    expect(r.steps.filter((s) => s.decidedBy === "ai").length).toBeGreaterThan(0);
    expect(r.steps.find((s) => s.tool === "check_official_site")?.rationale).toContain("公式サイト");
    // 提出した発見は、固定ロジックの判定（ページの種類）と照合される
    expect(r.agreement.some((a) => a.url === "https://toy.example.invalid/n/1" && a.agrees === true)).toBe(true);
  });
  it("検証の指摘を使わない設定（maxReviews=0）では追加調査は起きない。固定の方針は決定者が fixed_policy になる", async () => {
    const r = await executeInvestigation({ llm: new ScriptedAi(), world: world(), controls: controls(), sleep: async () => {}, maxReviews: 0 });
    expect(r.followUps).toBe(0);
    expect(r.steps.every((s) => s.decidedBy === "ai")).toBe(true);
  });
  it("buildReviewFeedback: 一覧ページの未確認リンク・AIと検証の判断の食い違いを指摘し、指摘が無ければ null", () => {
    const page: PageData = { url: "https://t.invalid/", title: "一覧", text: "x", links: [{ url: "https://t.invalid/n/1", text: "抽選販売のお知らせ" }] };
    const pv: AnalysisPreview = { url: "https://t.invalid/", pageKind: "announcement_index", recognized: false, chainName: "", storeName: "", products: [], applyDeadline: null, missing: [], disposition: { kind: "investigate", targetLotteryId: null, reason: "r" }, registrable: false, blockers: [], costJpy: 0 };
    const fb = buildReviewFeedback({ output: { tasks: [], findings: [], summary: "" }, pages: new Map([[page.url, page]]), previews: [pv], remaining: { fetches: 3 }, analysesLeft: 2 });
    expect(fb?.text).toContain("https://t.invalid/n/1");
    expect(fb?.meta.issues).toContain("index_unvisited");
    // 取得・解析の余力が無ければ指摘しない（上限は増えない）
    expect(buildReviewFeedback({ output: { tasks: [], findings: [], summary: "" }, pages: new Map([[page.url, page]]), previews: [pv], remaining: { fetches: 0 }, analysesLeft: 2 })).toBeNull();
    const dis = buildReviewFeedback({ output: { tasks: [], findings: [{ kind: "lottery_info", targetId: "c", title: "t", url: "https://t.invalid/", evidence: "e", official: true, pageKind: "lottery_announcement", action: "new" }], summary: "" }, pages: new Map([[page.url, { ...page, links: [] }]]), previews: [pv], remaining: { fetches: 0 }, analysesLeft: 0 });
    expect(dis?.meta.issues).toContain("kind_disagree");
  });
  it("ツールの入力・提出の形に、上限・権限・アクセス範囲を変える項目は無い。システムプロンプトは上限を「変更できない」と伝える", () => {
    const text = JSON.stringify(PLAN_SUBMIT_SCHEMA);
    for (const bad of ["limit", "maxFetches", "maxCost", "budget", "permission", "allow", "host", "robots", "token"]) expect(text.toLowerCase()).not.toContain(bad.toLowerCase());
    expect(INVESTIGATION_SYSTEM).toContain("変更できません");
    expect(INVESTIGATION_SYSTEM).not.toMatch(/Claude Code|APIキー/);
  });
  it("実AIのクライアント: 提出ツールの定義を渡し、出力が途切れたときは空の提出で安全に終える（実行しない）", async () => {
    const seen: { tools: { name: string }[] }[] = [];
    const client = {
      messages: {
        create: async (p: { tools: { name: string }[] }) => {
          seen.push(p);
          return { content: [{ type: "text", text: "途切れ" }], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 10 } };
        },
      },
    };
    const brain = createRealBrain(client as never, "claude-haiku-5-5");
    const s = await brain.step({ system: "s", messages: [{ role: "user", text: "t" }], tools: [{ name: "get_signals", description: "d", inputSchema: { type: "object" } }] });
    expect(s.kind).toBe("final");
    expect(seen[0].tools.map((t) => t.name)).toEqual(["get_signals", SUBMIT]);
  });
});
