// @vitest-environment node
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnthropicAgentLLM, AnthropicWebSearch } from "@/lib/agent/anthropic";
import { SYSTEM_PROMPT } from "@/lib/agent/store-location/run";
import { checkRealApi } from "@/lib/agent/real-gate";
import { REAL_GOLD, REAL_TARGETS, estimateRealCost, FileCache, collectRecords, isFatalProblem, isProblem, summarizeRecords, type RealRecord, preflight, runRealEval, validatePlan, type RealEvalPlan } from "@/lib/agent/store-location/real-eval";
import { matchesGoldV1, scoreEval, type EvalResult } from "@/lib/agent/store-location/eval";
import { verifyResearch } from "@/lib/agent/store-location/verify";
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
    expect(JSON.stringify(REAL_TARGETS)).not.toMatch(/expectedAddress|acceptableStatuses|mustNotAdopt|officialDomains|evidence|東京都武蔵野市|足立区東伊興|鶴見区鶴見|unknownGold|reviewNote/);
    expect(REAL_TARGETS.filter((t) => t.id.startsWith("R")).every((t) => t.store.knownDomains.length === 0)).toBe(true); // 8D-3: 公式サイトの発見を評価するため、登録済みの公式ドメインは空（8D-4 は店舗マスターの実際の登録のまま）
  });
  it("正解は人手（公式ページの取得）で確認した根拠つき。確認できないものは unknown と明記", () => {
    for (const g of REAL_GOLD) {
      expect(g.conditions.length, g.id).toBeGreaterThan(0);
      if (!g.unknownGold) expect((g as { evidence?: unknown[] }).evidence?.length, g.id).toBeGreaterThan(0);
    }
    expect(REAL_GOLD.filter((g) => !g.expectedAddress).every((g) => (g as { unknown?: string[] }).unknown?.length)).toBe(true);
  });
  it("Stage 8D-4: 新規30件（正解あり20・正解不明10）。R1〜R5 の店舗を含まず、全件が住所未登録の実店舗。正解は実行前に固定", () => {
    const n = REAL_TARGETS.filter((t) => /^[NU][0-9]+$/.test(t.id));
    expect(n).toHaveLength(30);
    expect(REAL_GOLD.filter((g) => /^N[0-9]+$/.test(g.id) && !g.unknownGold)).toHaveLength(20);
    expect(REAL_GOLD.filter((g) => /^U[0-9]+$/.test(g.id) && g.unknownGold)).toHaveLength(10);
    const key = (t: { store: { chain: string; name: string } }) => `${t.store.chain} ${t.store.name}`;
    const r5 = new Set(REAL_TARGETS.filter((t) => /^R[0-9]$/.test(t.id)).map(key));
    expect(n.some((t) => r5.has(key(t)))).toBe(false);
    expect(new Set(n.map(key)).size).toBe(30);
    // 正解不明は、正解を持たない（作らない）
    for (const g of REAL_GOLD.filter((x) => x.unknownGold)) expect(g.expectedAddress ?? null).toBeNull();
    // 正解あり20件は、番地までの住所と、公式ページの出典・確認日を持つ
    for (const g of REAL_GOLD.filter((x) => /^N[0-9]+$/.test(x.id))) {
      expect(g.expectedAddress, g.id).toMatch(/[都道府県]/);
      const ev = (g.evidence ?? []) as { url: string; verifiedOn: string }[];
      expect(ev.every((e) => e.url.startsWith("https://") && e.verifiedOn === "2026-11-12"), g.id).toBe(true);
    }
  });
  it("Stage 8D-4: 正解データ（住所・出典URL・注意書き）が、AIに渡す入力（店舗情報・システム指示・タスク文）に混入していない", () => {
    const hay = JSON.stringify(REAL_TARGETS.map((t) => t.store)) + SYSTEM_PROMPT;
    const flat = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "");
    const haystack = flat(hay);
    for (const g of REAL_GOLD.filter((x) => /^[NUPQ][0-9]+$/.test(x.id))) {
      if (g.expectedAddress) expect(haystack.includes(flat(g.expectedAddress)), `${g.id} の正解住所が入力に含まれる`).toBe(false);
      for (const e of (g.evidence ?? []) as { url: string; quote: string }[]) {
        expect(haystack.includes(flat(e.url)), `${g.id} の出典URLが入力に含まれる`).toBe(false);
      }
      for (const a of g.mustNotAdopt ?? []) expect(haystack.includes(flat(a)), `${g.id} の禁止住所が入力に含まれる`).toBe(false);
    }
    // 入力の店舗情報は、系列名・店舗名・都道府県・登録済みドメイン・同じ系列の他店舗名・系列の別名だけ
    for (const t of REAL_TARGETS) expect(Object.keys(t.store).sort()).toEqual(["chain", "chainAliases", "knownDomains", "name", "prefecture", "siblingNames"]);
    // 調査の実行基盤（run.ts・tools.ts・verify.ts）は、正解データ・評価データを読み込まない
    for (const f of ["run.ts", "tools.ts", "verify.ts", "official.ts", "mock.ts"]) {
      const src = readFileSync(`src/lib/agent/store-location/${f}`, "utf8");
      expect(src, f).not.toMatch(/real-stores|gold\.json|gold-8d4|REAL_GOLD/);
    }
  });
  it("Stage 8D-5: 未知の30件（正解あり20・正解不明10）。R・N・U の店舗を含まず、入力に住所を含まない。正解は実行前に固定", () => {
    const pq = REAL_TARGETS.filter((t) => /^[PQ][0-9]+$/.test(t.id));
    expect(pq).toHaveLength(30);
    expect(REAL_GOLD.filter((g) => /^P[0-9]+$/.test(g.id) && !g.unknownGold)).toHaveLength(20);
    expect(REAL_GOLD.filter((g) => /^Q[0-9]+$/.test(g.id) && g.unknownGold)).toHaveLength(10);
    const key = (t: { store: { chain: string; name: string } }) => `${t.store.chain} ${t.store.name}`;
    const prev = new Set(REAL_TARGETS.filter((t) => /^[RNU][0-9]+$/.test(t.id)).map(key));
    expect(pq.some((t) => prev.has(key(t)))).toBe(false);
    expect(new Set(pq.map(key)).size).toBe(30);
    for (const t of pq) expect(Object.keys(t.store).sort()).toEqual(["chain", "chainAliases", "knownDomains", "name", "prefecture", "siblingNames"]);
    for (const g of REAL_GOLD.filter((x) => /^P[0-9]+$/.test(x.id))) {
      expect(g.expectedAddress, g.id).toMatch(/[都道府県]/);
      const ev = (g.evidence ?? []) as { url: string; verifiedOn: string }[];
      expect(ev.length, g.id).toBeGreaterThan(0);
      expect(ev.every((e) => e.url.startsWith("https://") && e.verifiedOn === "2026-11-12"), g.id).toBe(true);
    }
    for (const g of REAL_GOLD.filter((x) => /^Q[0-9]+$/.test(x.id))) expect(g.expectedAddress ?? null).toBeNull();
    const cats = pq.map((t) => t.category).join(",");
    for (const c of ["official_stated", "official_hard", "similar_name", "name_differs", "closure_relocated", "unknown_gold_official_down", "unknown_gold_official_blocked", "unknown_gold_ambiguous"]) expect(cats, c).toContain(c);
  });
  it("Stage 8D-4: 評価対象に、公式に明記・公式が見つけにくい・類似名・系列名と店舗名が違う・閉店/移転・住所の一部・公式情報不足（正解不明）の各種が含まれる", () => {
    const cats = REAL_TARGETS.filter((t) => /^[NU][0-9]+$/.test(t.id)).map((t) => t.category).join(",");
    for (const c of ["official_stated", "official_hard", "similar_name", "name_differs", "closure", "partial_address", "unknown_gold_official_down", "unknown_gold_official_blocked"]) expect(cats, c).toContain(c);
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
  it("Stage 8D-4: 正解不明（U）は正解率の分母に含めず別に記録。初回/再実行を区別し、1日の実行回数の上限を超えない", async () => {
    const dir = "eval/runs/real-test";
    const empty = { name: "empty", async step() { return { kind: "final" as const, output: { candidates: [] }, usage: { inputTokens: 1, outputTokens: 1, costJpy: 0.1 } }; } };
    const deps = () => ({ llm: empty, search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: mockGeocode(EVAL_WORLD) });
    const rep = await runRealEval({ ids: ["N01", "U01", "U02"], approvedMaxJpy: 100, approvedStores: 3, firstOnly: false, continueOnProblem: true }, deps, { outDir: dir });
    expect(rep.phase).toBe("initial");
    expect(rep.records).toHaveLength(3);
    expect(rep.score?.cases).toBe(1); // 正解ありの N01 だけが採点される
    expect(rep.unknown.map((x) => x.id)).toEqual(["U01", "U02"]); // 正解不明は、調査結果と確認状況だけを別に記録
    const again = await runRealEval({ ids: ["N01", "N02", "N03"], approvedMaxJpy: 100, approvedStores: 3, firstOnly: false, phase: "rerun" }, deps, { outDir: dir, remainingRuns: 2 });
    expect(again.phase).toBe("rerun");
    expect(again.records).toHaveLength(2);
    expect(again.stoppedReason).toMatch(/実行回数/);
  });
  it("Stage 8D-4: 誤住所は記録して続けるが、API障害は継続指定でも必ず止まる。不正なツール使用・費用超過も止まる", async () => {
    const dir = "eval/runs/real-test";
    const down = { name: "down", async step() { throw new Error("認証エラー"); } };
    const rep = await runRealEval({ ids: ["N01", "N02", "N03"], approvedMaxJpy: 100, approvedStores: 3, firstOnly: false, continueOnProblem: true }, () => ({ llm: down, search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: mockGeocode(EVAL_WORLD) }), { outDir: dir });
    expect(rep.records).toHaveLength(1);
    expect(rep.stoppedReason).toMatch(/停止/);
    expect(isFatalProblem({ status: "failed", rejectedCalls: 0, costJpy: 1 }, 15)).toMatch(/API障害/);
    expect(isFatalProblem({ status: "candidate", rejectedCalls: 1, costJpy: 1 }, 15)).toMatch(/ツール/);
    expect(isFatalProblem({ status: "candidate", rejectedCalls: 0, costJpy: 19 }, 15)).toMatch(/上限/);
    expect(isFatalProblem({ status: "candidate", rejectedCalls: 0, costJpy: 3 }, 15)).toBeNull();
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
    const plan: RealEvalPlan = { ids, approvedMaxJpy: Number(env.REAL_EVAL_APPROVED_MAX_JPY) || 0, approvedStores: Number(env.REAL_EVAL_APPROVED_STORES) || 0, firstOnly: env.REAL_EVAL_FIRST_ONLY === "1", phase: env.REAL_EVAL_PHASE === "rerun" ? "rerun" : "initial", continueOnProblem: env.REAL_EVAL_CONTINUE === "1", maxProblems: Number(env.REAL_EVAL_MAX_PROBLEMS) || undefined };
    const maxRuns = Number(env.AGENT_MAX_RUNS_PER_DAY) || 0;
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
      { limits: gate.limits, remainingRuns: Math.max(0, maxRuns - runsToday), onRecord: (r) => console.log(`[real] ${r.target.id} ${r.outcome.status} ${r.outcome.address ?? "-"} cost=${r.usage.costJpy.toFixed(2)}円 searches=${r.usage.searches} fetches=${r.usage.fetches}${r.problem ? ` 問題: ${r.problem}` : ""}`) },
    );
    writeFileSync(counterPath, JSON.stringify({ date: today, n: runsToday + rep.records.length }));
    console.log(`[real] 実行 ${rep.records.length} 件 / 推定費用 ${rep.spentJpy.toFixed(2)}円 / ${rep.stoppedReason ?? "完了"}`);
    expect(rep.records.length).toBeGreaterThan(0);
  }, 3_600_000);
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

// ---------------------------------------------------------------- 集計（Stage 8D-4）
describe("集計: 初回の主要評価値。正解不明は分母に含めない", () => {
  const rec = (id: string, status: string, address: string | null, over: Partial<RealRecord["usage"]> = {}, sites: { domain: string; status: string }[] = [], actions: string[] = ["web_search", "fetch_page"]): RealRecord => {
    const target = REAL_TARGETS.find((x) => x.id === id)!;
    return {
      target, result: { caseId: id, status: status as never, address, confidence: 70, searches: 2, fetches: 1, steps: 4, costJpy: 3, ms: 1000, injectionFlags: 0 },
      outcome: { status, address, confidence: 70, reasons: [], officialSites: sites.map((s) => ({ ...s, signals: [], problems: [] })), sources: [] },
      usage: { steps: 4, searches: 2, fetches: 1, inputTokens: 1000, outputTokens: 100, costJpy: 3, ms: 1000, retries: 0, rejectedCalls: 0, injectionFlags: 0, ...over },
      actions: actions.map((name) => ({ name, ok: true, arg: "" })), engine: "anthropic:test", problem: null,
    };
  };
  it("正しい住所・誤住所・確認済みの誤り・公式判定・人手確認・追加調査を、正解ありの店舗だけで数える", () => {
    const s = summarizeRecords([
      rec("N16", "confirmed", "三重県名張市夏見3303", {}, [{ domain: "nextone-iga.co.jp", status: "trusted" }]), // 正しい・確認済み・公式OK
      rec("N18", "candidate", "東京都豊島区東池袋1丁目31-1", { searches: 3 }), // 正しい・候補・追加調査（検索3回）
      rec("N19", "confirmed", "東京都世田谷区玉川9-9-9", {}, [{ domain: "kiddyland.co.jp", status: "verified" }]), // 誤りを確認済みにした
      rec("N05", "insufficient", null, {}, [], ["web_search", "fetch_page", "web_search"]), // 情報不足・追加調査（取得のあとに検索）
      rec("U01", "confirmed", "大阪府大阪市中央区日本橋1-1-1"), // 正解不明: 分母に含めない
    ]);
    expect(s.stores).toBe(5);
    expect(s.known.n).toBe(4);
    expect(s.known.correctRate).toBe(2 / 4);
    expect(s.known.confirmedSuccessRate).toBe(1 / 4);
    expect(s.known.wrongAdopted).toBe(1);
    expect(s.known.wrongConfirmed).toBe(1);
    expect(s.known.officialFound).toBe(2);
    expect(s.known.humanReviewRate).toBe(2 / 4);
    expect(s.known.additionalSearchRate).toBe(2 / 4);
    expect(s.unknown).toMatchObject({ n: 1, confirmed: 1 });
    expect(s.totals.costJpy).toBe(15);
    expect(s.perStore.find((x) => x.id === "U01")!.correct).toBeNull();
  });
  it("collectRecords: 同じ店舗の最初の実行だけを数え、初回と再実行を混ぜない", () => {
    const dir = "eval/runs/real-test-collect";
    mkdirSync(dir, { recursive: true });
    const base = { plan: {}, unknown: [], stoppedReason: null, spentJpy: 0, score: null, startedAt: "x" };
    writeFileSync(`${dir}/real-1.json`, JSON.stringify({ ...base, runId: "1", phase: "initial", records: [rec("N01", "candidate", "A")] }));
    writeFileSync(`${dir}/real-2.json`, JSON.stringify({ ...base, runId: "2", phase: "initial", records: [rec("N01", "confirmed", "B"), rec("N02", "candidate", "C")] }));
    writeFileSync(`${dir}/real-3.json`, JSON.stringify({ ...base, runId: "3", phase: "rerun", records: [rec("N01", "confirmed", "D")] }));
    const initial = collectRecords(dir, "initial", (id) => id.startsWith("N"));
    expect(initial.map((r) => [r.target.id, r.outcome.address])).toEqual([["N01", "A"], ["N02", "C"]]); // 同じ店舗は最初の結果
    expect(collectRecords(dir, "rerun", (id) => id.startsWith("N")).map((r) => r.outcome.address)).toEqual(["D"]);
  });
});

// 集計の出力（REAL_REPORT=1。API・ネットワークには接続しない）
describe.skipIf(process.env.REAL_REPORT !== "1")("集計の出力（表示のみ）", () => {
  it("初回・再実行を別に集計して eval/runs/real/summary-8d4-*.json に書く", () => {
    for (const phase of ["initial", "rerun"] as const) {
      const recs = collectRecords("eval/runs/real", phase, (id) => /^[NUPQ][0-9]+$/.test(id));
      writeFileSync(`eval/runs/real/summary-8d4-${phase}.json`, JSON.stringify(summarizeRecords(recs), null, 2));
      writeFileSync(`eval/runs/real/summary-8d4-${phase}-original-scorer.json`, JSON.stringify(summarizeRecords(recs, matchesGoldV1), null, 2)); // 初回の採点（旧版）を再現
    }
  });
});

// ---------------------------------------------------------------- 保存済みデータでの再検証（REAL_REPLAY=1。有料APIは使わない）
// 実行記録（eval/runs/real/real-*.json）に残した「AIの提出（住所・情報源・引用）」と、取得済みのページ（cache.json）を使い、
// 検証層（verifyResearch）だけを現在のコードでやり直す。AIの出力・取得したページは変えない（検索・AI呼び出しは行わない）。
describe.skipIf(process.env.REAL_REPLAY !== "1")("保存済みデータでの再検証（有料API・検索なし）", () => {
  it("初回の記録を、現在の検証層で再判定して eval/runs/real/replay-8d4.json に書く", async () => {
    const cache = JSON.parse(readFileSync("eval/runs/real/cache.json", "utf8")) as Record<string, { v: { ok?: boolean; url: string; finalUrl: string; title: string; text: string; links?: { text: string; href: string }[] } }>;
    const pageFor = (arg: string) => {
      const key = Object.keys(cache).find((k) => k.startsWith(`page:${arg}`));
      const v = key ? cache[key].v : null;
      return v && v.ok !== false ? { url: v.url, finalUrl: v.finalUrl, title: v.title, text: v.text, links: v.links, injection: false } : null;
    };
    // 各店舗の最初の記録（N・U は初回の実行、R は最後の実行）
    const first = new Map<string, RealRecord>();
    for (const f of readdirSync("eval/runs/real").filter((x) => /^real-.*json$/.test(x)).sort()) {
      const rep = JSON.parse(readFileSync(`eval/runs/real/${f}`, "utf8")) as { phase?: string; records: RealRecord[] };
      for (const r of rep.records) {
        if (/^[NU]/.test(r.target.id)) { if ((rep.phase ?? "initial") === "initial" && !first.has(r.target.id)) first.set(r.target.id, r); }
        else first.set(r.target.id, r); // R1〜R5: 最後の記録（修正後の再実行）
      }
    }
    const rows: Record<string, unknown>[] = [];
    const replayed: RealRecord[] = [];
    for (const r of first.values()) {
      const pages = r.actions.filter((a) => a.name === "fetch_page" && a.ok).map((a) => pageFor(a.arg)).filter((p): p is NonNullable<typeof p> => !!p);
      const proposal = { candidates: (r.outcome.candidates ?? []).map((c) => ({ address: c.address, sourceUrl: c.sourceUrl, quote: c.quote, closureHint: c.closureHint ?? null })) };
      const res = await verifyResearch({ store: r.target.store, proposal, pages, geocode: realGeocode, limitReached: false });
      rows.push({ id: r.target.id, before: { status: r.outcome.status, address: r.outcome.address, confidence: r.outcome.confidence }, after: { status: res.status, address: res.address, confidence: res.confidence, reasons: res.reasons, officialSites: res.officialSites.map((o) => `${o.domain}:${o.status}`) }, pages: pages.length, candidates: proposal.candidates.length });
      replayed.push({ ...r, outcome: { ...r.outcome, status: res.status, address: res.address, confidence: res.confidence, reasons: res.reasons, officialSites: res.officialSites.map((o) => ({ domain: o.domain, status: o.status, signals: o.signals, problems: o.problems })) } });
    }
    writeFileSync("eval/runs/real/replay-8d4.json", JSON.stringify({ rows, summaryNU: summarizeRecords(replayed.filter((r) => /^[NU]/.test(r.target.id))), summaryR: replayed.filter((r) => /^R/.test(r.target.id)).map((r) => ({ id: r.target.id, status: r.outcome.status, address: r.outcome.address })) }, null, 2));
    expect(rows.length).toBeGreaterThan(0);
  }, 600_000);
});
