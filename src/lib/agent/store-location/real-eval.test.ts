// @vitest-environment node
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnthropicAgentLLM, AnthropicWebSearch } from "@/lib/agent/anthropic";
import { checkRealApi } from "@/lib/agent/real-gate";
import { REAL_GOLD, REAL_TARGETS, estimateRealCost, FileCache, isProblem, preflight, runRealEval, validatePlan, type RealEvalPlan } from "@/lib/agent/store-location/real-eval";
import { scoreEval, type EvalResult } from "@/lib/agent/store-location/eval";
import { MockFetcher, MockSearch, MockStoreBrain, mockGeocode } from "@/lib/agent/store-location/mock";
import { EVAL_WORLD } from "@/lib/agent/store-location/world";
import { CachedFetcher, CachedSearch } from "@/lib/agent/store-location/tools";
import { SafePageFetcher, realGeocode } from "@/lib/server/agent/real-providers";

/**
 * 実在店舗の評価（Stage 8D-3）。
 *  - 通常のテスト（常に実行）: データの整合・費用の見積もり・承認範囲の検査・停止条件・実行基盤（モック部品）の動作。実APIは使わない。
 *  - 実API（REAL_EVAL=1 のときだけ。scripts/eval-real.mjs 経由。承認された件数・費用の範囲のみ）。
 */
describe("実在店舗の評価データ", () => {
  it("入力（targets）と正解（gold）は1対1で、入力に正解・住所が混入していない", () => {
    expect(REAL_TARGETS.map((t) => t.id).sort()).toEqual(REAL_GOLD.map((g) => g.id).sort());
    expect(JSON.stringify(REAL_TARGETS)).not.toMatch(/expectedAddress|acceptableStatuses|mustNotAdopt|officialDomains|evidence|東京都武蔵野市|足立区東伊興|鶴見区鶴見/);
    expect(REAL_TARGETS.every((t) => t.store.knownDomains.length === 0)).toBe(true); // 公式サイトの発見を評価するため、登録済みの公式ドメインは空
  });
  it("正解は人手（公式ページの取得）で確認した根拠つき。確認できないものは unknown と明記", () => {
    for (const g of REAL_GOLD) {
      expect(g.conditions.length, g.id).toBeGreaterThan(0);
      expect((g as { evidence?: unknown[] }).evidence?.length, g.id).toBeGreaterThan(0);
    }
    expect(REAL_GOLD.filter((g) => !g.expectedAddress).every((g) => (g as { unknown?: string[] }).unknown?.length)).toBe(true);
  });
  it("評価対象に、公式サイトが明記された店舗・同名の別地域・名称と住所の地名が違う店舗・公式が見つけにくい店舗・特定できない店舗が含まれる", () => {
    const cats = REAL_TARGETS.map((t) => t.category);
    for (const c of ["official_easy_confusable", "name_differs_from_address_area", "same_name_other_region", "no_official_page_found_easily", "may_be_unidentifiable"]) expect(cats).toContain(c);
  });
});

describe("費用の見積もりと承認範囲", () => {
  it("見積もり: 1店舗の上限は15円。5件で上限75円。典型値は上限以下", () => {
    const e = estimateRealCost(5);
    expect(e.perStoreCapJpy).toBe(15);
    expect(e.totalCapJpy).toBe(75);
    expect(e.perStoreTypicalJpy).toBeGreaterThan(2);
    expect(e.perStoreTypicalJpy).toBeLessThan(15);
    expect(e.assumptions.join()).toMatch(/Haiku|haiku/);
  });
  const ok: RealEvalPlan = { ids: ["R1"], approvedMaxJpy: 20, approvedStores: 1, firstOnly: true };
  it("承認された件数・費用の範囲内だけ実行できる", () => {
    expect(validatePlan(ok)).toBeNull();
    expect(validatePlan({ ...ok, approvedMaxJpy: 0 })).toMatch(/承認/);
    expect(validatePlan({ ...ok, approvedStores: 0 })).toMatch(/承認/);
    expect(validatePlan({ ...ok, ids: ["R1", "R2"], firstOnly: false })).toMatch(/件数/);
    expect(validatePlan({ ...ok, approvedMaxJpy: 10 })).toMatch(/超えています/); // 1店舗の上限15円が承認額を超える
    expect(validatePlan({ ...ok, ids: ["R9"] })).toMatch(/未知/);
  });
  it("停止条件: 失敗・誤住所・ツールの不正使用・費用の大幅超過", () => {
    const base = { status: "candidate", wrong: false, rejectedCalls: 0, costJpy: 5 };
    expect(isProblem(base, 15)).toBeNull();
    expect(isProblem({ ...base, status: "failed" }, 15)).toMatch(/失敗/);
    expect(isProblem({ ...base, wrong: true }, 15)).toMatch(/誤った住所/);
    expect(isProblem({ ...base, rejectedCalls: 1 }, 15)).toMatch(/ツール/);
    expect(isProblem({ ...base, costJpy: 19 }, 15)).toMatch(/費用/);
  });
  it("実行前の確認は、API・ネットワークに接続せず、キーを出力しない。承認が無ければ計画に問題が出る", () => {
    const env = { TOREMANE_ENV: "local", AGENT_REAL_API: "allow", AGENT_ANTHROPIC_API_KEY: "secret-key-value", AGENT_MAX_COST_JPY_PER_RUN: "15", AGENT_MAX_RUNS_PER_DAY: "5" };
    const p = preflight(env, ["R1"]);
    expect(p.gate.ok).toBe(true);
    expect(JSON.stringify(p)).not.toContain("secret-key-value");
    expect(p.planProblem).toMatch(/承認/);
    const none = preflight({}, ["R1"]);
    expect(none.gate.ok).toBe(false);
  });
});

describe("実行基盤（モック部品で、実APIなしに動作確認）", () => {
  it("1件ごとに保存し、停止条件で残りを止め、承認額を超える実行はしない", async () => {
    const dir = "eval/runs/real-test";
    mkdirSync(dir, { recursive: true });
    // 1店舗あたり16円かかる疑似AI（上限15円の範囲内の超過）。承認額45円では、3件目の前に（32円使用済み+上限15円）が承認額を超えるため止まる
    const costly = { name: "costly", async step() { return { kind: "final" as const, output: { candidates: [] }, usage: { inputTokens: 1, outputTokens: 1, costJpy: 16 } }; } };
    const plan: RealEvalPlan = { ids: ["R1", "R2", "R3"], approvedMaxJpy: 45, approvedStores: 3, firstOnly: false };
    const seen: string[] = [];
    const rep = await runRealEval(plan, () => ({ llm: costly, search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: mockGeocode(EVAL_WORLD) }), { outDir: dir, onRecord: (r) => seen.push(r.target.id) });
    expect(seen).toEqual(["R1", "R2"]); // 3件目は、承認額を超える可能性があるため実行しない
    expect(rep.stoppedReason).toMatch(/承認された総費用/);
    expect(existsSync(`${dir}/real-${rep.runId}.json`)).toBe(true);
    expect(JSON.parse(readFileSync(`${dir}/real-${rep.runId}.json`, "utf8")).records).toHaveLength(2);
    expect(JSON.stringify(rep)).not.toMatch(/api[_-]?key|sk-ant/i);
  });
  it("最初の1店舗だけの実行（firstOnly）。問題があれば止まる", async () => {
    const dir = "eval/runs/real-test";
    const rep = await runRealEval({ ids: ["R1", "R2"], approvedMaxJpy: 100, approvedStores: 2, firstOnly: true }, (t) => ({ llm: new MockStoreBrain({ chain: t.store.chain, name: t.store.name }), search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: mockGeocode(EVAL_WORLD) }), { outDir: dir });
    expect(rep.records).toHaveLength(1);
    const failing = await runRealEval({ ids: ["R1", "R2"], approvedMaxJpy: 100, approvedStores: 2, firstOnly: false }, () => ({ llm: { name: "down", async step() { throw new Error("認証エラー"); } }, search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: mockGeocode(EVAL_WORLD) }), { outDir: dir });
    expect(failing.records).toHaveLength(1); // 最初の店舗が失敗 → 残りは停止
    expect(failing.stoppedReason).toMatch(/停止/);
    expect(failing.records[0].outcome.status).toBe("failed");
  });
  it("採点: 前半一致の正解（R4）は前半が合えば正しい、R5 は同じ系列の別店舗（尼崎本店）の住所を採用すると誤り", () => {
    const r = (caseId: string, address: string | null, status = "candidate"): EvalResult => ({ caseId, status: status as never, address, confidence: 40, searches: 1, fetches: 1, steps: 3, costJpy: 5, ms: 1000, injectionFlags: 0 });
    const s = scoreEval("t", [r("R4", "京都府京都市伏見区横大路芝生1-1"), r("R5", "兵庫県尼崎市立花町1丁目26-12"), r("R3", "神奈川県横浜市鶴見区鶴見1-1-1")], REAL_GOLD.filter((g) => ["R3", "R4", "R5"].includes(g.id)));
    expect(s.perCase.find((p) => p.caseId === "R4")!.wrong).toBe(false);
    expect(s.perCase.find((p) => p.caseId === "R5")!.wrong).toBe(true);
    expect(s.perCase.find((p) => p.caseId === "R3")!.wrong).toBe(true);
    const ok = scoreEval("t", [r("R5", "兵庫県神戸市兵庫区吉田町2丁目38-10")], REAL_GOLD.filter((x) => x.id === "R5"));
    expect(ok.perCase[0].wrong).toBe(false);
  });
  it("採点: 正解の後ろに建物名・階数が付いた住所（R1）は正しい。番地の続きや町名だけは誤り", () => {
    const r = (address: string): EvalResult => ({ caseId: "R1", status: "confirmed", address, confidence: 75, searches: 1, fetches: 1, steps: 3, costJpy: 1, ms: 1000, injectionFlags: 0 });
    const g = REAL_GOLD.filter((x) => x.id === "R1");
    const wrongOf = (a: string) => scoreEval("t", [r(a)], g).perCase[0].wrong;
    expect(wrongOf("東京都武蔵野市吉祥寺本町1-11-5 コピス吉祥寺 6階/A館")).toBe(false);
    expect(wrongOf("東京都武蔵野市吉祥寺本町1-11-5")).toBe(false);
    expect(wrongOf("東京都武蔵野市吉祥寺本町1-11-50")).toBe(true);
    expect(wrongOf("東京都武蔵野市吉祥寺")).toBe(true);
  });
  it("FileCache: 保存・再読み込み・期限切れ", () => {
    const path = "eval/runs/real-test/cache.json";
    let t = 0;
    const c1 = new FileCache(path, 1000, () => t);
    c1.set("k", { a: 1 });
    expect(new FileCache(path, 1000, () => t).get("k")).toEqual({ a: 1 });
    t = 5000;
    expect(new FileCache(path, 1000, () => t).get("k")).toBeUndefined();
  });
});

// ---------------------------------------------------------------- 実API（承認済みの範囲のみ）
describe.skipIf(process.env.REAL_EVAL !== "1")("実API評価（承認済みの件数・費用の範囲のみ）", () => {
  it("実在店舗を実行して結果を保存する", async () => {
    const env = process.env as Record<string, string | undefined>;
    mkdirSync("eval/runs/real", { recursive: true });
    const counterPath = "eval/runs/real/.day-count.json";
    const today = new Date().toISOString().slice(0, 10);
    const counter = existsSync(counterPath) ? JSON.parse(readFileSync(counterPath, "utf8")) : { date: today, n: 0 };
    const runsToday = counter.date === today ? counter.n : 0;
    const gate = checkRealApi({ env, confirm: true, runsToday });
    if (!gate.ok) throw new Error(`実APIの関門: ${gate.reason}`);
    const ids = (env.REAL_EVAL_IDS ?? "R1").split(",").map((x) => x.trim()).filter(Boolean);
    const plan: RealEvalPlan = { ids, approvedMaxJpy: Number(env.REAL_EVAL_APPROVED_MAX_JPY) || 0, approvedStores: Number(env.REAL_EVAL_APPROVED_STORES) || 0, firstOnly: env.REAL_EVAL_FIRST_ONLY === "1" };
    const client = new Anthropic({ apiKey: gate.apiKey }); // キーは出力・保存しない
    const cache = new FileCache("eval/runs/real/cache.json");
    const rep = await runRealEval(
      plan,
      () => ({
        llm: new AnthropicAgentLLM(client, gate.model),
        search: new CachedSearch(new AnthropicWebSearch(client, gate.model), cache),
        fetcher: new CachedFetcher(new SafePageFetcher(), cache),
        geocode: realGeocode,
      }),
      { limits: gate.limits, onRecord: (r) => console.log(`[real] ${r.target.id} ${r.outcome.status} ${r.outcome.address ?? "-"} cost=${r.usage.costJpy.toFixed(2)}円 searches=${r.usage.searches} fetches=${r.usage.fetches}${r.problem ? ` 問題: ${r.problem}` : ""}`) },
    );
    writeFileSync(counterPath, JSON.stringify({ date: today, n: runsToday + rep.records.length }));
    console.log(`[real] 実行 ${rep.records.length} 件 / 推定費用 ${rep.spentJpy.toFixed(2)}円 / ${rep.stoppedReason ?? "完了"}`);
    expect(rep.records.length).toBeGreaterThan(0);
  }, 600_000);
});

// ---------------------------------------------------------------- 実行前の確認の表示（REAL_PREFLIGHT=1。API・ネットワークには接続しない）
describe.skipIf(process.env.REAL_PREFLIGHT !== "1")("実行前の確認（表示のみ）", () => {
  it("関門・計画・費用の見積もりを表示する", () => {
    const ids = (process.env.REAL_EVAL_IDS ?? REAL_TARGETS.map((t) => t.id).join(",")).split(",").map((x) => x.trim()).filter(Boolean);
    const p = preflight(process.env as Record<string, string | undefined>, ids);
    mkdirSync("eval/runs/real", { recursive: true });
    writeFileSync("eval/runs/real/preflight.json", JSON.stringify(p, null, 2)); // 表示は scripts/eval-real.mjs が行う（キーは含まない）
    expect(p.estimate.stores).toBeGreaterThan(0);
  });
});
