// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeExtraction } from "@/lib/ai/extraction";
import { validateExtraction } from "@/lib/ai/validate";
import type { AgentLLM, AgentMessage, LlmStep, ToolCall } from "@/lib/agent/core";
import { resolveControls } from "@/lib/agent/collection-planner/controls";
import type { PlannerWorld } from "@/lib/agent/collection-planner/types";
import { decideApplyUnit } from "@/lib/collector/understanding";
import { applyCaseFileToExtraction } from "@/lib/case-model/merge";
import { investigationNeeds } from "@/lib/case-model/judgment";
import { caseFromExtraction } from "@/lib/case-model/from-extraction";
import { investigateCase, type CaseInvestigationResult } from "./engine";
import type { CaseTarget } from "./ledger";
import { resultToCaseFile } from "./to-case";
import { parseDateRange } from "./tools";

/**
 * Stage 9H-3B: 調査エージェント → 共通モデル → 通常収集の入口（ExtractedLottery への合流）→ 既存の応募単位判定、までを実際の部品で通すシナリオ試験。
 * 有料AIなし。AIの出力は「保存済みの実行ログ（backups/eval-9h2）で実際のAIが返した形」（店舗の羅列を店舗として報告・当選発表の期間を1つの値として報告）を台本にする。
 * 台本は AI の報告だけを与え、ツールの検証・台帳の統合・共通モデルへの変換・合流・判定は実際のコードが行う（正しい最終値を直接与えない）。
 */

const NOW = new Date("2026-11-14T03:00:00Z");
const none = { year: null, month: null, day: null, hour: null, minute: null };
const usage = { inputTokens: 100, outputTokens: 50, costJpy: 0 };

/** 台本どおりに行動するAI。各手は直前までの会話を見られる（検証層の指摘を読むため） */
class ScriptedLLM implements AgentLLM {
  readonly name = "scripted";
  readonly seen: AgentMessage[][] = [];
  private i = 0;
  constructor(private readonly script: (((m: AgentMessage[]) => LlmStep) | LlmStep)[]) {}
  async step(input: { messages: AgentMessage[] }): Promise<LlmStep> {
    this.seen.push(input.messages);
    const s = this.script[Math.min(this.i++, this.script.length - 1)];
    return typeof s === "function" ? s(input.messages) : s;
  }
}
let n = 0;
const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `c${++n}`, name, input });
const tools = (...calls: ToolCall[]): LlmStep => ({ kind: "tool_calls", calls, usage });
const finish = (reason: "sufficient" | "no_improvement" | "cannot_continue", note = ""): LlmStep => ({ kind: "final", output: { reason, note }, usage });

const LP = "https://livepocket.jp/e/test-9h3b";
const BODY = [
  "【ポケモンカードゲーム MEGA 拡張パック ハドウシーカー 1BOX 抽選販売】フルコンプ",
  "販売受付期間: 2026/11/11 〜 2026/11/15 12:00",
  "■応募期間 2026年11月11日（水）告知開始時～11月15日（日）11:59",
  "■当選発表 2026年11月16日（月）～ 11月21日（土）",
  "■対象店舗 フルコンプ横浜店／秋葉原店／渋谷東口店／川崎店／本厚木店／池袋店／立川店／大宮店",
  "■応募方法 抽選申込ページの店舗選択欄から、受け取りを希望する店舗を1つ選択して応募",
].join("\n");
const STORES = ["フルコンプ横浜店", "秋葉原店", "渋谷東口店", "川崎店", "本厚木店", "池袋店", "立川店", "大宮店"];

function world(pages: Record<string, string | { fail: string } | { text: string; links: { url: string; text: string }[] }>): PlannerWorld {
  return {
    signals: async () => ({ today: "2026-11-14", releases: [], chains: [], missing: [], failed: [], monitors: [], discovery: { found7d: 0, registered7d: 0, held7d: 0 } }),
    fetchPage: async (url) => {
      const p = pages[url];
      if (p === undefined) return { ok: false, reason: "ページが見つかりません（404）" };
      if (typeof p === "object" && "fail" in p) return { ok: false, reason: p.fail };
      if (typeof p === "object") return { ok: true, title: "告知", text: p.text, links: p.links };
      return { ok: true, title: "告知", text: p, links: [] };
    },
    matchExisting: async () => [],
  };
}
const controls = () => {
  const d = resolveControls({ runsToday: 0, costTodayJpy: 0, workerDailyAiLimit: 30, aiCallsToday: 0 }, { mode: "dry_run", realApi: false });
  if (!d.ok) throw new Error("controls");
  return d.controls;
};
const target = (o: Partial<CaseTarget> = {}): CaseTarget => ({ id: "k-9h3b", chain: "フルコンプ", products: ["ハドウシーカー"], known: {}, manualFields: [], knownSources: [{ url: LP, kind: "platform" }], ...o });
async function investigate(llm: AgentLLM, w: PlannerWorld, t: CaseTarget, maxReviews = 0, classify?: import("./source-class").ClassifyContext): Promise<CaseInvestigationResult> {
  let t0 = 1_800_000_000_000;
  return investigateCase({ llm, world: w, target: t, controls: controls(), now: () => (t0 += 50), sleep: async () => {}, maxReviews, ...(classify ? { classify } : {}) });
}
const ID = { chain: "フルコンプ", products: ["ハドウシーカー"], applyDeadline: "2026-11-15 11:59" };
const obs = (field: string, value: string, quote: string) => ({ field, value, quote });

/** 通常収集のAI読み取り（本番の収集の AI 出力と同じ形。実際の記録: フルコンプは店舗の羅列を店舗に、当選発表の終了日は無し、応募単位は不明） */
function productionExtraction(over: Record<string, unknown> = {}) {
  const raw = {
    is_lottery_announcement: true, chain_name: "フルコンプ", store_name: "", prefecture: "",
    products: [{ name: "ハドウシーカー", code: "", quantity: 1, unit: "box" }],
    apply_start: none, apply_deadline: { year: 2026, month: 11, day: 15, hour: 11, minute: 59 }, result_date: none, result_end_date: none,
    procedure_start: none, procedure_deadline: none, conditions_text: "LivePocketの会員登録が必要", receive_method: "store", apply_method: "web", apply_url: "",
    apply_unit: "unknown", selectable_stores: [], evidence: [], warnings: [], ...over,
  };
  return validateExtraction(normalizeExtraction(raw, NOW, {}), null, {});
}

describe("当選発表の期間: 開始日・終了日が失われない（9H-2では期間が形式検証で拒否され台帳が空になっていた）", () => {
  it("parseDateRange: 期間の表記ゆれを受け付け、終了が開始より前の値は受け付けない", () => {
    expect(parseDateRange("2026-11-16〜2026-11-21")).toEqual({ start: "2026-11-16", end: "2026-11-21" });
    expect(parseDateRange("2026-11-16 ~ 2026-11-21")).toEqual({ start: "2026-11-16", end: "2026-11-21" });
    expect(parseDateRange("2026-11-16 - 2026-11-21")).toEqual({ start: "2026-11-16", end: "2026-11-21" });
    expect(parseDateRange("2026-11-21〜2026-11-16")).toBeNull();
    expect(parseDateRange("2026-11-16")).toBeNull();
  });

  it("AIが期間を1つの値として報告 → 台帳 → 案件ファイル → 通常収集の抽出結果まで、開始・終了の両方が保持される", async () => {
    const llm = new ScriptedLLM([
      tools(call("get_case_state", {}), call("fetch_source_page", { url: LP })),
      tools(call("report_page_findings", { url: LP, identity: ID, observations: [obs("resultDate", "2026-11-16〜2026-11-21", "2026年11月16日（月）～ 11月21日（土）")] })),
      finish("sufficient"),
    ]);
    const r = await investigate(llm, world({ [LP]: BODY }), target());
    // ツール段階: 期間は拒否されず、開始が resultDate、終了が追加項目に入る
    const rep = r.steps.find((s) => s.tool === "report_page_findings")!;
    expect(rep.detail).toMatchObject({ accepted: expect.arrayContaining(["resultDate", "resultEnd"]), rejected: [] });
    expect(r.fields.find((f) => f.field === "resultDate")!.adopted).toBe("2026-11-16");
    expect(r.extras.find((x) => x.key === "resultEnd")!.value).toBe("2026-11-21");
    // 共通モデル
    const c = resultToCaseFile(r, target(), NOW.toISOString());
    expect(c.fields.resultStart.value).toBe("2026-11-16");
    expect(c.fields.resultEnd.value).toBe("2026-11-21");
    expect(c.fields.resultEnd.evidence[0].quote).toContain("11月21日");
    // 通常収集の入口へ合流（既存の読み取りに当選発表が無かった）
    const m = applyCaseFileToExtraction(productionExtraction(), c);
    expect(m.extraction.resultDate).toMatchObject({ precision: "date_only", date: "2026-11-16" });
    expect(m.extraction.resultEndDate).toBe("2026-11-21");
    // 応募期間と当選発表の期間を混同していない
    expect(m.extraction.applyDeadline).toMatchObject({ date: "2026-11-15", time: "11:59" });
  });
});

describe("フルコンプ: 店舗選択式が保持される（9H-2では8店舗の羅列が店舗の値になっていた）", () => {
  const llmFor = () =>
    new ScriptedLLM([
      tools(call("get_case_state", {}), call("fetch_source_page", { url: LP })),
      // 実際のAIの報告と同じ形: 対象店舗の羅列を店舗として報告する
      tools(call("report_page_findings", { url: LP, identity: ID, observations: [obs("store", "フルコンプ横浜店／秋葉原店／渋谷東口店／川崎店／本厚木店／池袋店／立川店／大宮店", "フルコンプ横浜店／秋葉原店／渋谷東口店／川崎店／本厚木店／池袋店／立川店／大宮店")] })),
      // 検証層の拒否を読んで、応募の単位を根拠つきで報告する
      (m) => {
        const last = [...m].reverse().find((x) => x.role === "tool" && x.name === "report_page_findings");
        expect(last && "content" in last ? last.content : "").toContain("applyUnit");
        return tools(call("report_page_findings", { url: LP, identity: ID, applyUnit: { unit: "store_select", selectableStores: [...STORES, "存在しない店"], quote: "店舗選択欄から、受け取りを希望する店舗を1つ選択して応募" }, observations: [obs("store", STORES[0], "フルコンプ横浜店")] }));
      },
      finish("sufficient"),
    ]);

  it("店舗の羅列は店舗の値にならず、店舗選択式と選べる店舗（ページに実在するものだけ）が案件ファイルに残る", async () => {
    const r = await investigate(llmFor(), world({ [LP]: BODY }), target());
    const first = r.steps.filter((s) => s.tool === "report_page_findings")[0];
    expect(JSON.stringify(first.detail)).toContain("複数の店舗の羅列は店舗の値にできない");
    const second = r.steps.filter((s) => s.tool === "report_page_findings")[1];
    expect(JSON.stringify(second.detail)).toContain("店舗名「存在しない店」がページの本文に見つからない"); // 根拠の無い店舗は採用しない
    expect(JSON.stringify(second.detail)).toContain("店舗選択式のため、店舗の値にしない");
    expect(r.fields.find((f) => f.field === "store")!.state).toBe("missing");
    const c = resultToCaseFile(r, target(), NOW.toISOString());
    expect(c.fields.form).toMatchObject({ value: "store_select", by: "investigation" });
    expect(c.fields.form.evidence[0].quote).toContain("店舗選択欄");
    expect(c.fields.selectableStores.value?.split(" / ")).toEqual(STORES);
    expect(c.fields.store.value).toBeNull();
  });

  it("通常収集の入口へ合流 → 既存の応募単位の判定（decideApplyUnit）が店舗選択式を採用し、調査が必要かの判定も解消する", async () => {
    const r = await investigate(llmFor(), world({ [LP]: BODY }), target());
    const c = resultToCaseFile(r, target(), NOW.toISOString());
    const before = productionExtraction({ store_name: STORES.join("／") });
    // 合流前: 店舗の羅列が店舗名で、応募単位は不明 → 調査が必要
    expect(investigationNeeds(caseFromExtraction(before, "k", { url: LP, at: "t" })).needed).toBe(true);
    const m = applyCaseFileToExtraction(productionExtraction({ store_name: "" }), c);
    expect(m.extraction.applyUnit).toBe("store_select");
    expect(m.extraction.selectableStoreNames).toEqual(STORES);
    const d = decideApplyUnit({ aiUnit: m.extraction.applyUnit, storeMode: "fixed", texts: [], sourceUrls: [LP] });
    expect(d.form).toBe("store_select");
    expect(d.overridden).toBe(false); // AI（調査）の判断を、固定ロジックが根拠なく覆していない
    expect(investigationNeeds(caseFromExtraction(m.extraction, "k", { url: LP, at: "t" })).reasons.map((x) => x.code)).not.toContain("store_unidentified");
  });
});

describe("お宝創庫・キデイランド: 複数ブランドの店舗選択式と、店舗別独立を区別する", () => {
  const OT = "https://livepocket.jp/e/otakara-9h3b";
  const MULTI = ["【抽選販売】スペシャルデッキセットMEGA お宝創庫グループ", "■応募方法 応募フォームのプルダウンから受取店舗を選択（お宝創庫／トレカ創庫／ゲーム創庫の各店舗）", "■対象店舗 お宝創庫 渋谷店・お宝創庫 新宿店・トレカ創庫 池袋店・ゲーム創庫 立川店"].join("\n");
  it("複数ブランドの店舗が選べる店舗として保持され、ブランドの違いで店舗を捨てない", async () => {
    const llm = new ScriptedLLM([
      tools(call("get_case_state", {}), call("fetch_source_page", { url: OT })),
      tools(call("report_page_findings", { url: OT, identity: { chain: "お宝創庫グループ", products: ["スペシャルデッキセットMEGA"] }, applyUnit: { unit: "store_select", selectableStores: ["お宝創庫 渋谷店", "お宝創庫 新宿店", "トレカ創庫 池袋店", "ゲーム創庫 立川店"], quote: "応募フォームのプルダウンから受取店舗を選択" }, observations: [] })),
      finish("sufficient"),
    ]);
    const t = target({ chain: "お宝創庫グループ", products: ["スペシャルデッキセットMEGA"], knownSources: [{ url: OT, kind: "platform" }] });
    const r = await investigate(llm, world({ [OT]: MULTI }), t);
    const c = resultToCaseFile(r, t, NOW.toISOString());
    expect(c.fields.form.value).toBe("store_select");
    expect(c.fields.selectableStores.value?.split(" / ")).toEqual(["お宝創庫 渋谷店", "お宝創庫 新宿店", "トレカ創庫 池袋店", "ゲーム創庫 立川店"]);
  });

  it("店舗ごとに別の応募ページ（店舗別独立）は店舗選択式にならない。AIが店舗別独立と報告すれば、その判断が通常収集まで届く", async () => {
    const KD = "https://livepocket.jp/e/kiddy-9h3b";
    const PAGE = "【抽選】ハドウシーカー キデイランド 吉祥寺店\n■応募方法 吉祥寺店の応募ページ（店舗ごとに応募ページが異なります）から応募\n■応募期間 2026年11月11日～11月15日 11:59";
    const llm = new ScriptedLLM([
      tools(call("get_case_state", {}), call("fetch_source_page", { url: KD })),
      tools(call("report_page_findings", { url: KD, identity: { chain: "キデイランド", store: "吉祥寺店", products: ["ハドウシーカー"], applyDeadline: "2026-11-15 11:59" }, applyUnit: { unit: "store_independent", quote: "店舗ごとに応募ページが異なります" }, observations: [obs("store", "吉祥寺店", "吉祥寺店の応募ページ")] })),
      finish("sufficient"),
    ]);
    const t = target({ chain: "キデイランド", store: "吉祥寺店", knownSources: [{ url: KD, kind: "platform" }] });
    const r = await investigate(llm, world({ [KD]: PAGE }), t);
    const c = resultToCaseFile(r, t, NOW.toISOString());
    expect(c.fields.form.value).toBe("store_independent");
    expect(c.fields.store.value).toBe("吉祥寺店"); // 店舗別なので店舗は保持される
    expect(c.fields.selectableStores.value).toBeNull();
    const m = applyCaseFileToExtraction(productionExtraction({ chain_name: "キデイランド", store_name: "吉祥寺店" }), c);
    expect(m.extraction.applyUnit).toBe("store_independent");
    expect(m.extraction.storeName).toBe("吉祥寺店");
  });
});

describe("イトーヨーカドー: 系列の表記違い（ネット通販）を別の系列・矛盾にしない", () => {
  it("調査が『イトーヨーカドー』と読み取っても、既存の『イトーヨーカドーネット通販』と同じ系列として扱い、変更にも矛盾にもしない。店舗『通販』は保持される", async () => {
    const IY = "https://livepocket.jp/e/iy-9h3b";
    const PAGE = "【抽選】イトーヨーカドー ハドウシーカー 通販\n■応募期間 2026年11月12日～11月13日 11:59\n■販売方法 ネット通販";
    const llm = new ScriptedLLM([
      tools(call("get_case_state", {}), call("fetch_source_page", { url: IY })),
      tools(call("report_page_findings", { url: IY, identity: { chain: "イトーヨーカドー", store: "通販", products: ["ハドウシーカー"], applyDeadline: "2026-11-13 11:59" }, observations: [obs("chain", "イトーヨーカドー", "イトーヨーカドー ハドウシーカー 通販"), obs("store", "通販", "ネット通販")] })),
      finish("sufficient"),
    ]);
    const t = target({ chain: "イトーヨーカドーネット通販", store: "通販", knownSources: [{ url: IY, kind: "platform" }] });
    const r = await investigate(llm, world({ [IY]: PAGE }), t);
    const c = resultToCaseFile(r, t, NOW.toISOString());
    expect(c.fields.chain.value).toBe("イトーヨーカドー");
    const ex = productionExtraction({ chain_name: "イトーヨーカドーネット通販", store_name: "通販" });
    const m = applyCaseFileToExtraction(ex, c);
    // 9H-3E: 同じ系列の表記違いは矛盾にせず、短い表記（人間の評価: 登録済みの系列「イトーヨーカドー」と同一）に統一し、理由を記録する。店舗「通販」は変えない
    expect(m.extraction.chainName).toBe("イトーヨーカドー");
    expect(m.decisions.filter((d) => d.field === "chain").map((d) => d.kind)).toEqual(["changed"]);
    expect(m.decisions.some((d) => d.field === "store")).toBe(false);
    expect(m.extraction.storeName).toBe("通販");
    expect(m.extraction.warnings.some((w) => w.includes("食い違"))).toBe(false);
  });
});

describe("LivePocket: 主催者の本文とサービス側の受付表示を区別する", () => {
  it("受付表示（〜11/16 12:00）と本文（11/15 11:59）が違うとき、本文を優先し、受付表示の値は別の値として残す。根拠の層（basis）が案件ファイルまで届く", async () => {
    const PAGE = ["【抽選】ハドウシーカー フルコンプ", "販売受付期間: 2026/11/11 〜 2026/11/16 12:00", "■応募期間 2026年11月11日～11月15日（日）11:59"].join("\n");
    const llm = new ScriptedLLM([
      tools(call("get_case_state", {}), call("fetch_source_page", { url: LP })),
      tools(call("report_page_findings", { url: LP, identity: { chain: "フルコンプ", products: ["ハドウシーカー"] }, observations: [obs("applyDeadline", "2026-11-16 12:00", "販売受付期間: 2026/11/11 〜 2026/11/16 12:00"), obs("applyDeadline", "2026-11-15 11:59", "11月15日（日）11:59")] })),
      finish("sufficient"),
    ]);
    const r = await investigate(llm, world({ [LP]: PAGE }), target());
    const f = r.fields.find((x) => x.field === "applyDeadline")!;
    expect(f.adopted).toBe("2026-11-15 11:59");
    expect(f.state).not.toBe("conflict");
    expect(f.alternatives.map((a) => a.value)).toEqual(["2026-11-16 12:00"]);
    const c = resultToCaseFile(r, target(), NOW.toISOString());
    expect(c.fields.applyDeadline.evidence.some((e) => e.basis === "organizer_body")).toBe(true);
    expect(c.fields.applyDeadline.alternatives[0].value).toBe("2026-11-16 12:00");
  });
});

describe("人間が確定した項目の保護", () => {
  it("調査の報告が違っても台帳は手動確定の値を変えない。案件ファイルは『人間確定』を引き継ぎ、合流でも上書きされない", async () => {
    const llm = new ScriptedLLM([
      tools(call("get_case_state", {}), call("fetch_source_page", { url: LP })),
      tools(call("report_page_findings", { url: LP, identity: ID, observations: [obs("applyDeadline", "2026-11-15 11:59", "11月15日（日）11:59")] })),
      finish("sufficient"),
    ]);
    const t = target({ known: { applyDeadline: "2026-11-14 23:59" }, manualFields: ["applyDeadline"] });
    const r = await investigate(llm, world({ [LP]: BODY }), t);
    expect(r.steps.find((s) => s.tool === "report_page_findings")!.detail).toMatchObject({ skipped: [{ field: "applyDeadline", reason: expect.stringContaining("手動で確定") }] });
    const c = resultToCaseFile(r, t, NOW.toISOString());
    expect(c.humanLocked).toContain("applyDeadline");
    expect(c.fields.applyDeadline).toMatchObject({ value: "2026-11-14 23:59", state: "manual", by: "human" });
    const m = applyCaseFileToExtraction(productionExtraction({ apply_deadline: { year: 2026, month: 11, day: 14, hour: 23, minute: 59 } }), c);
    expect(m.extraction.applyDeadline).toMatchObject({ date: "2026-11-14", time: "23:59" });
  });
});

describe("AIの判断が台帳から消えない: 取得したのに報告されなかったページ", () => {
  const P2 = "https://matome.example.invalid/hado";
  it("終了の申告だけでは記録されない。検証層が未報告のページを指摘し、報告すれば台帳に入る。指摘後も報告しなければ『反映していない』と記録される", async () => {
    const pages = { [LP]: BODY, [P2]: "ハドウシーカー フルコンプ 抽選 11月15日（日）11:59まで" };
    const llm = new ScriptedLLM([
      tools(call("get_case_state", {}), call("fetch_source_page", { url: LP }), call("fetch_source_page", { url: P2 })),
      tools(call("report_page_findings", { url: LP, identity: ID, observations: [obs("applyDeadline", "2026-11-15 11:59", "11月15日（日）11:59")] })),
      finish("sufficient", "2件とも同じ内容を確認"),
      finish("sufficient", "再度申告"),
    ]);
    const t = target({ knownSources: [{ url: LP, kind: "platform" }, { url: P2, kind: "aggregator" }] });
    const r = await investigate(llm, world(pages), t, 1);
    // 検証層の指摘は、提出（終了の申告）への返答として AI に届く
    const feedback = llm.seen.flat().map((m) => (m.role === "tool" ? m.content : "")).join("\n");
    expect(feedback).toContain(`取得済みの ${P2} の内容が報告されていません`);
    expect(r.unreported).toContain(P2);
    const c = resultToCaseFile(r, t, NOW.toISOString());
    expect(c.decisions.some((d) => d.kind === "dropped" && d.before === P2 && d.reason.includes("報告されなかった"))).toBe(true);
    expect(c.sources.find((s) => s.url === P2)?.status).toBe("unreported");
  });
});

describe("LivePocket: 主催者の同一性を確認できたときだけ、主催者本文を一次情報として評価する（ドメイン全体を一次にしない）", () => {
  const rep = (url: string, extra: { field: string; value: string; quote: string }[]) => tools(call("report_page_findings", { url, identity: ID, observations: extra }));
  const run1 = (url: string, text: string | { text: string; links: { url: string; text: string }[] }, classify?: import("./source-class").ClassifyContext) =>
    investigate(new ScriptedLLM([tools(call("get_case_state", {}), call("fetch_source_page", { url })), rep(url, [obs("applyDeadline", "2026-11-15 11:59", "11月15日（日）11:59")]), finish("sufficient")]), world({ [url]: text }), target({ knownSources: [{ url, kind: "platform" }] }), 0, classify);
  const dl = (r: CaseInvestigationResult) => r.fields.find((f) => f.field === "applyDeadline")!;

  it("主催者欄が対象の系列と一致 → 主催者本文の項目は一次情報（根拠1件で確定）。根拠の分類（一次・主催者本文・主催者の確認）が共通モデルへ届く", async () => {
    const r = await run1(LP, "【抽選】ハドウシーカー\n主催者: フルコンプ\n■応募期間 2026年11月11日～11月15日（日）11:59");
    expect(r.sources.find((s) => s.url === LP)!.organizer).toMatchObject({ status: "verified" });
    expect(dl(r)).toMatchObject({ state: "confirmed", hasPrimary: true });
    expect(dl(r).sources[0]).toMatchObject({ tier: "primary", basis: "organizer_body" });
    const c = resultToCaseFile(r, target({ knownSources: [{ url: LP, kind: "platform" }] }), NOW.toISOString());
    expect(c.fields.applyDeadline).toMatchObject({ state: "confirmed" });
    expect(c.fields.applyDeadline.evidence[0]).toMatchObject({ tier: "primary", basis: "organizer_body" });
    expect(c.sources.find((s) => s.url === LP)?.note).toContain("主催者: 確認済み");
    expect(c.decisions.some((d) => d.reason.includes("主催者の確認: 確認済み"))).toBe(true);
  });

  it("別の主催者のページ（見出しに系列名があっても）は一次にならず、未確認のまま。確認できない理由が記録される", async () => {
    const r = await run1(LP, "【フルコンプ ハドウシーカー抽選のお知らせ】\n主催者: 株式会社べつの店\n■応募期間 2026年11月11日～11月15日（日）11:59");
    expect(r.sources.find((s) => s.url === LP)!.organizer).toMatchObject({ status: "unverified" });
    expect(dl(r)).toMatchObject({ state: "unverified", hasPrimary: false });
    expect(dl(r).sources[0].tier).toBe("secondary");
    const c = resultToCaseFile(r, target({ knownSources: [{ url: LP, kind: "platform" }] }), NOW.toISOString());
    expect(c.decisions.some((d) => d.reason.includes("主催者の確認: 未確認") && d.reason.includes("一致しない"))).toBe(true);
    // 主催者欄が無く、見出しに系列名があるだけでも確認しない
    const r2 = await run1(LP, "【フルコンプ ハドウシーカー抽選】\n■応募期間 2026年11月11日～11月15日（日）11:59");
    expect(r2.sources.find((s) => s.url === LP)!.organizer).toMatchObject({ status: "unverified", basis: expect.stringContaining("主催者を確認できる記載がない") });
    expect(dl(r2).state).toBe("unverified");
  });

  it("登録済みの公式サイトへのリンク・公式アカウントの記載があれば確認できる。サービス側の受付表示は、主催者を確認できても一次にしない", async () => {
    const cls = { officialHosts: ["fullcomp.example.invalid"], officialAccounts: ["fullcomp_jp"], aggregatorHosts: [], aggregatorAccounts: [] };
    const linked = await run1(LP, { text: "【抽選】ハドウシーカー\n■応募期間 2026年11月11日～11月15日（日）11:59", links: [{ url: "https://fullcomp.example.invalid/news", text: "公式サイト" }] }, cls);
    expect(linked.sources.find((s) => s.url === LP)!.organizer).toMatchObject({ status: "verified", basis: expect.stringContaining("公式サイト") });
    expect(dl(linked).state).toBe("confirmed");
    const acct = await run1(LP, "【抽選】ハドウシーカー\n公式 @fullcomp_jp からのお知らせ\n■応募期間 2026年11月11日～11月15日（日）11:59", cls);
    expect(acct.sources.find((s) => s.url === LP)!.organizer).toMatchObject({ status: "verified", basis: expect.stringContaining("@fullcomp_jp") });
    // 受付表示（meta）の項目: 主催者を確認できても二次のまま
    const llm = new ScriptedLLM([tools(call("get_case_state", {}), call("fetch_source_page", { url: LP })), tools(call("report_page_findings", { url: LP, identity: ID, observations: [obs("applyDeadline", "2026-11-15 12:00", "販売受付期間: 2026/11/11 〜 2026/11/15 12:00")] })), finish("sufficient")]);
    const meta = await investigate(llm, world({ [LP]: "主催者: フルコンプ\n販売受付期間: 2026/11/11 〜 2026/11/15 12:00" }), target(), 0);
    expect(dl(meta).state).toBe("unverified");
    expect(dl(meta).sources[0]).toMatchObject({ tier: "secondary", basis: "platform_meta" });
  });

  it("同じ応募サービスの別ページは、ページごとに判定する（片方が確認できても、もう片方は一次にならない）", async () => {
    const LP2 = "https://livepocket.jp/e/other-organizer";
    const llm = new ScriptedLLM([
      tools(call("get_case_state", {}), call("fetch_source_page", { url: LP }), call("fetch_source_page", { url: LP2 })),
      tools(call("report_page_findings", { url: LP, identity: ID, observations: [obs("applyStart", "2026-11-11", "2026年11月11日")] }), call("report_page_findings", { url: LP2, identity: ID, observations: [obs("conditions", "会員登録が必要", "会員登録が必要") ] })),
      finish("sufficient"),
    ]);
    const t = target({ knownSources: [{ url: LP, kind: "platform" }, { url: LP2, kind: "platform" }] });
    const r = await investigate(llm, world({ [LP]: "主催者: フルコンプ\n2026年11月11日から", [LP2]: "主催者: 別のお店\n会員登録が必要" }), t, 0);
    expect(r.fields.find((f) => f.field === "applyStart")!.hasPrimary).toBe(true);
    expect(r.fields.find((f) => f.field === "conditions")!.hasPrimary).toBe(false);
  });
});

describe("9H-3D 実評価で見つかった誤統合の再発防止: 店舗が不明な案件に、別の店舗の告知を統合しない", () => {
  const SAPPORO = "https://shop.example.invalid/blog/sapporo";
  const NAMBA = "https://shop.example.invalid/blog/namba";
  const pages = {
    [SAPPORO]: "平素よりカードラボ札幌店をご利用頂き\n商品名：ハドウシーカー\n応募期間：2026年11月4日(水)～11月8日(日)",
    [NAMBA]: "・カードラボなんば店\n商品名：ハドウシーカー\n応募期間：2026年11月13日（金）～11月15日（日）",
  };
  it("保存された実評価と同じ識別（系列一致・商品一致・店舗は特定の別店舗・締切が同じ日）でも、対象の店舗が不明なら同じ抽選と認めず保留する", async () => {
    const llm = new ScriptedLLM([
      tools(call("get_case_state", {}), call("fetch_source_page", { url: SAPPORO }), call("fetch_source_page", { url: NAMBA })),
      tools(
        call("report_page_findings", { url: SAPPORO, identity: { chain: "カードラボ", store: "札幌店", products: ["ハドウシーカー"], applyStart: "2026-11-04", applyDeadline: "2026-11-08" }, observations: [obs("applyStart", "2026-11-04", "2026年11月4日(水)")] }),
        call("report_page_findings", { url: NAMBA, identity: { chain: "カードラボ", store: "なんば店", products: ["ハドウシーカー"], applyStart: "2026-11-13", applyDeadline: "2026-11-15" }, observations: [obs("applyStart", "2026-11-13", "2026年11月13日（金）")] }),
      ),
      finish("no_improvement"),
    ]);
    const t = target({ chain: "カードラボ", store: undefined, products: ["ハドウシーカー"], known: { applyDeadline: "2026-11-15 23:59" }, knownSources: [{ url: SAPPORO, kind: "aggregator" }, { url: NAMBA, kind: "aggregator" }] });
    const r = await investigate(llm, world(pages), t, 0);
    expect(r.fields.find((f) => f.field === "applyStart")!.state).toBe("missing"); // どちらの店舗の開始日も採用しない
    expect(r.sources.filter((s) => s.status === "quarantined").map((s) => s.url).sort()).toEqual([NAMBA, SAPPORO]);
    const c = resultToCaseFile(r, t, NOW.toISOString());
    expect(c.fields.applyStart.value).toBeNull();
    expect(c.decisions.filter((d) => d.kind === "held" && d.reason.includes("同じ抽選と確認できない")).length).toBeGreaterThanOrEqual(1);
  });
  it("対象の店舗が分かっていて一致するときは、従来どおり統合する（店舗選択式・店舗不明でない案件への副作用なし）", async () => {
    const llm = new ScriptedLLM([
      tools(call("get_case_state", {}), call("fetch_source_page", { url: NAMBA })),
      tools(call("report_page_findings", { url: NAMBA, identity: { chain: "カードラボ", store: "なんば店", products: ["ハドウシーカー"], applyDeadline: "2026-11-15" }, observations: [obs("applyStart", "2026-11-13", "2026年11月13日（金）")] })),
      finish("sufficient"),
    ]);
    const t = target({ chain: "カードラボ", store: "なんば店", products: ["ハドウシーカー"], known: {}, knownSources: [{ url: NAMBA, kind: "aggregator" }] });
    const r = await investigate(llm, world(pages), t, 0);
    expect(r.fields.find((f) => f.field === "applyStart")!.adopted).toBe("2026-11-13");
  });
});
