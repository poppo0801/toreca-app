// @vitest-environment node
/**
 * 同条件比較試験の**評価入口**（Phase 2・開発専用・ローカルDBのみ）。`scripts/compare-phase2.mjs` が起動する。一般の画面・server action・cron・収集の接続口から呼ばれない（静的テスト）。
 *   PHASE2_CMP_MODE=plan           … 件数・API呼び出し数・費用の見積・合否基準・承認文・停止条件を表示するだけ（AI・検索・ネットワークなし・無課金）
 *   PHASE2_CMP_MODE=mock           … 台本のAI（費用0）で、候補の作成→登録案→採点→比較の全経路を通す。**結果は精度ではなく仕組みの確認**
 *   PHASE2_CMP_MODE=export-cases   … ローカルDBの候補（保存済みの実データ）から、AIが見る入力（cases.local.json）を作る（gold・AI出力は含めない）
 *   PHASE2_CMP_MODE=gold-template  … 人が gold を記入するための下書き（gold-template.local.json）を作る（AI出力を含めない）
 *   PHASE2_CMP_MODE=run            … **有料**。承認額・確認文・開発専用キー・関門・事前検査・独立goldの検証・計画の費用がすべて通ったときだけ実AIを呼ぶ
 * 本番Supabase・本番の候補には接続しない（ローカルのSupabaseでなければ止まる）。結果は eval/phase2-compare/*.local.json（Git管理外）。原文・URL・キー・gold を標準出力・Gitに出さない。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { checkJudgmentRealRun } from "@/lib/judgment/real-gate";
import { composeR1Cases, pageCandidate, validatePageGold, worksheetMarkdown, type R1PageGold } from "@/lib/judgment/xsource/r1-worksheet";
import { armsOf, EXPERIMENTS, planComparison, splitCalibration, validateGold, type CompareCase, type ExperimentId, type GoldCase } from "@/lib/judgment/xsource/compare-eval";
import { HostThrottle, RunFetchBudget } from "@/lib/collector/fetch-control";
import { makeRealVisionClient, worstCaseVisionCallJpy } from "@/lib/judgment/xsource/vision-real";
import { fetchPublicImage } from "@/lib/server/images/image-fetch";
import { splitPublicImage } from "@/lib/server/images/split-adapter";
import type { Db } from "@/lib/server/lottery-service";
import { casesFromCandidates, CMP_HOST, goldTemplate, prepareArmCandidates, runExperimentMock, scoreExperiment, seedGoldExperiences } from "./compare-run";
import type { CandidateRow } from "./generate";
import { runRealProposals, type RunEvent } from "./real-run";

vi.mock("server-only", () => ({}));
const env = process.env;
const MODE = env.PHASE2_CMP_MODE;
const DIR = "eval/phase2-compare";
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/;
const ALL: ExperimentId[] = ["links", "text_depth", "image", "hints"];
const experiments = (): ExperimentId[] => (env.PHASE2_CMP_EXPERIMENTS ? (env.PHASE2_CMP_EXPERIMENTS.split(",").filter((x) => (ALL as string[]).includes(x)) as ExperimentId[]) : ALL);

const admin = () => {
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!LOCAL.test(url)) throw new Error("ローカルのSupabase以外には接続しません（本番の候補に対して実行しない）");
  return createClient(url, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
};
const read = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null);
/** 入力と gold の読み込み。ローカルの実データが無ければ、架空のサンプル（仕組みの確認用）にする。サンプルでは実AIを実行しない */
const load = (): { cases: CompareCase[]; gold: GoldCase[]; sample: boolean } => {
  const cases = read<CompareCase[]>(`${DIR}/cases.local.json`);
  const gold = read<GoldCase[]>(`${DIR}/gold.local.json`);
  if (cases && gold) return { cases, gold, sample: false };
  return { cases: read<CompareCase[]>(`${DIR}/sample/cases.json`) ?? [], gold: read<GoldCase[]>(`${DIR}/sample/gold.json`) ?? [], sample: true };
};
const CAPS = () => ({ totalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY) || Number(env.PHASE2_CMP_TOTAL_JPY) || 60, perCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) || Number(env.PHASE2_CMP_PER_CASE_JPY) || 5, maxImagesPerCase: 4, maxFetchPerCase: 30, maxMinutes: 120 });
const planOf = (cases: CompareCase[], gold: GoldCase[], model = "claude-haiku-5-5") => {
  const avgImages = cases.length ? cases.reduce((n, c) => n + Math.min(4, c.imageRefs.length), 0) / cases.length : 0;
  const avgItems = cases.length ? Math.max(1, Math.round(cases.reduce((n, c) => n + Math.max(1, c.pages.length), 0) / cases.length)) : 3;
  const image = worstCaseVisionCallJpy(model, [{ width: 1200, height: 1600 }]);
  return planComparison({ experiments: experiments(), cases: cases.length, itemsPerCase: avgItems, imagesPerCase: Math.round(avgImages * 10) / 10, model, avgJpy: { agentTurn: 0.163, judge: 0.148, image: Number.isFinite(image) ? image : 0.15 }, turnsPerItem: 2, judgesPerItem: 1.3, caps: CAPS(), goldCases: gold.length });
};

describe.skipIf(!["plan", "mock", "export-cases", "gold-template", "r1-worksheet", "r1-build", "run"].includes(MODE ?? "") || env.PHASE2_COMPARE !== "1")("Phase 2 同条件比較試験（評価入口）", () => {
  it("plan: 実行前の計画（無課金）", () => {
    if (MODE !== "plan") return;
    const { cases, gold, sample } = load();
    const v = validateGold(gold);
    const p = planOf(cases, gold);
    console.log("PLAN", JSON.stringify({ input: sample ? "架空のサンプル（仕組みの確認用。実AIの実行には使えない）" : "ローカルの実データ", experiments: experiments(), cases: cases.length, goldCases: gold.length, goldValid: v.ok, goldErrors: v.errors.slice(0, 5), arms: experiments().flatMap((e) => armsOf(e).map((a) => `${a.id}（${a.label}）`)), questions: Object.fromEntries(experiments().map((e) => [e, EXPERIMENTS[e].question])), plan: p }));
    expect(cases.length).toBeGreaterThan(0);
  });

  it("export-cases: ローカルDBの候補（保存済みの実データ）から入力を作る（goldは含めない）", async () => {
    if (MODE !== "export-cases") return;
    const db = admin();
    const { data: hh } = await db.from("households").select("id").limit(1).maybeSingle();
    const { data } = await db.from("collection_candidates").select("id,x_post_id,source_url,last_good,dedupe_key").eq("household_id", hh!.id).like("dedupe_key", env.PHASE2_CMP_FROM ?? "https://eval-p.invalid/%").order("dedupe_key");
    const rows = (data ?? []) as unknown as CandidateRow[];
    const cases = await casesFromCandidates(db as unknown as Db, hh!.id, rows);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(`${DIR}/cases.local.json`, JSON.stringify(cases, null, 1));
    console.log("EXPORTED", JSON.stringify({ cases: cases.length }));
    expect(cases.length).toBeGreaterThan(0);
  });

  it("gold-template: 人が記入する gold の下書き（AI出力を含めない）", () => {
    if (MODE !== "gold-template") return;
    const cases = read<CompareCase[]>(`${DIR}/cases.local.json`) ?? [];
    expect(cases.length).toBeGreaterThan(0);
    writeFileSync(`${DIR}/gold-template.local.json`, JSON.stringify(goldTemplate(cases), null, 1));
    console.log("TEMPLATE", JSON.stringify({ cases: cases.length, next: "記入後、gold の配列だけを eval/phase2-compare/gold.local.json に保存する" }));
  });

  it("r1-worksheet: 保存済みの実在の公開ページ（LivePocket）から、人が独立goldを確認するための資料を作る（AI出力を含めない）", () => {
    if (MODE !== "r1-worksheet") return;
    const dir = "eval/real-data/10t-html";
    const idx = JSON.parse(readFileSync(`${dir}/index.json`, "utf8")) as { n: number; url: string; ok: boolean }[];
    const pages = idx.filter((x) => x.ok).map((x) => ({ n: x.n, url: x.url, html: readFileSync(`${dir}/lp-${x.n}.html`, "utf8") }));
    const cands = pages.map(pageCandidate);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(`${DIR}/r1-worksheet.local.md`, worksheetMarkdown(cands));
    const skeleton: R1PageGold[] = cands.map((c) => ({ n: c.n, verified: { by: "human", at: "", basis: "" }, store: c.storeCandidate ?? "", product: (c.productCandidate ?? "").replace(/^\d{1,2}\/\d{1,2}[(（][^)）]*[)）]発売\s*/, ""), applyEnd: c.applyEndGuess ? `2026-${c.applyEndGuess.md.split("/").map((x) => x.padStart(2, "0")).join("-")}` : null, applyUnit: null, region: null, evidence: c.applyEndGuess ? [{ quote: c.applyEndGuess.quote }] : [] }));
    writeFileSync(`${DIR}/r1-gold-pages.template.local.json`, JSON.stringify(skeleton, null, 1));
    console.log("R1_WORKSHEET", JSON.stringify({ pages: pages.length, recognized: cands.filter((c) => c.recognized).length, withStore: cands.filter((c) => c.storeCandidate).length, withDeadlineCandidate: cands.filter((c) => c.deadlineCandidates.length).length, needAttention: cands.filter((c) => c.attention.length).length, next: "r1-worksheet.local.md を見て、r1-gold-pages.template.local.json を記入し r1-gold-pages.local.json として保存" }));
    expect(pages.length).toBeGreaterThan(0);
  });

  it("r1-build: 人が確認したページ単位のgoldから、R1の比較用の案件とgoldを組み立てる", () => {
    if (MODE !== "r1-build") return;
    const dir = "eval/real-data/10t-html";
    const idx = JSON.parse(readFileSync(`${dir}/index.json`, "utf8")) as { n: number; url: string; ok: boolean }[];
    const pages = idx.filter((x) => x.ok).map((x) => ({ n: x.n, url: x.url, html: readFileSync(`${dir}/lp-${x.n}.html`, "utf8") }));
    const g = read<R1PageGold[]>(`${DIR}/r1-gold-pages.local.json`);
    if (!g) throw new Error("実行しません: r1-gold-pages.local.json（人が確認した gold）がありません");
    const v = validatePageGold(g, pages);
    if (!v.ok) throw new Error(`実行しません: gold が条件を満たしていません: ${v.errors.slice(0, 3).join(" / ")}`);
    const out = composeR1Cases({ pages, gold: g, cases: Number(env.PHASE2_CMP_R1_CASES) || 12, linksPerCase: 3, at: new Date().toISOString() });
    const gv = validateGold(out.gold);
    if (!gv.ok) throw new Error(`実行しません: ${gv.errors.slice(0, 3).join(" / ")}`);
    writeFileSync(`${DIR}/cases.local.json`, JSON.stringify(out.cases, null, 1));
    writeFileSync(`${DIR}/gold.local.json`, JSON.stringify(out.gold, null, 1));
    console.log("R1_BUILT", JSON.stringify({ cases: out.cases.length, goldCases: out.gold.length, pagesUsed: g.filter((x) => !x.exclude).length }));
    expect(out.cases.length).toBeGreaterThan(0);
  });

  it("mock: 台本のAI（費用0）で全経路を通す。結果は精度ではない", async () => {
    if (MODE !== "mock") return;
    const db = admin();
    const { data: hh } = await db.from("households").select("id").limit(1).maybeSingle();
    const { cases, gold, sample } = load();
    const out: Record<string, unknown> = {};
    for (const e of experiments()) {
      const r = await runExperimentMock({ db: db as unknown as Db, householdId: hh!.id, experiment: e, cases, gold, env: { ...env, PROPOSAL_PREVIEW: "on" } });
      out[e] = { verdict: r.comparison.verdict, claim: r.claim, cases: r.comparison.cases, required: r.comparison.required, paired: r.comparison.paired, goldLeak: r.goldLeak.ok, reasons: r.comparison.reasons };
    }
    console.log("MOCK", JSON.stringify({ input: sample ? "sample" : "local", ...out }));
    expect(Object.keys(out)).toHaveLength(experiments().length);
  }, 600_000);

  it("run: 実AI（有料・承認後）。関門・事前検査・独立goldの検証・停止条件つき", async () => {
    if (MODE !== "run") return;
    const { cases, gold, sample } = load();
    if (sample) throw new Error("実行しません: 架空のサンプルでは実AIを実行しない（cases.local.json と、人が作った gold.local.json が必要）");
    const v = validateGold(gold);
    if (!v.ok) throw new Error(`実行しません: gold が独立した人の確認の条件を満たしていません: ${v.errors.slice(0, 3).join(" / ")}`);
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const plan = planOf(cases, gold, gate.model);
    if (!plan.withinCap) throw new Error(`実行しません: 計画の期待費用 ${plan.expectedJpy}円が承認額 ${plan.warnings.join(" / ")}`);
    const db = admin();
    const { data: hh } = await db.from("households").select("id").limit(1).maybeSingle();
    const hid = hh!.id as string;
    const now = new Date().toISOString();
    const exps = experiments();
    // hints: 経験の元は校正用の案件の gold だけ。評価用の案件で比較する
    const split = exps.includes("hints") ? splitCalibration(cases) : null;
    if (split) await seedGoldExperiences({ db: db as unknown as Db, householdId: hid, cases: split.calibration, gold, at: now });
    const prepared = [];
    for (const e of exps) prepared.push(...(await prepareArmCandidates({ db: db as unknown as Db, householdId: hid, experiment: e, cases: e === "hints" && split ? split.evaluation : cases, now })));
    // 案件ごとにアーム（baseline/treatment）を隣り合わせて実行する（予算が尽きても、片方のアームだけが多く評価されない）
    const armOf = new Map(prepared.map((p) => [p.candidate.id, p.arm]));
    const order = [...prepared].sort((a, b) => a.caseId.localeCompare(b.caseId) || a.arm.experiment.localeCompare(b.arm.experiment) || a.arm.role.localeCompare(b.arm.role));
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model); // モデルの利用可否（無課金）
    mkdirSync(DIR, { recursive: true });
    const audit = `${DIR}/audit.local.jsonl`;
    const onEvent = (e: RunEvent) => appendFileSync(audit, JSON.stringify({ t: new Date().toISOString(), ...e }) + "\n");
    const runBudget = new RunFetchBudget({ maxRequests: 200, maxBytes: 100 * 1024 * 1024, maxImages: 40, deadlineAt: Date.now() + CAPS().maxMinutes * 60_000 });
    const throttle = new HostThrottle();
    let visionStats: unknown = null;
    const wantImages = exps.includes("image") && env.PHASE2_CMP_IMAGES === "allow";
    const summary = await runRealProposals({
      db: db as unknown as Db,
      householdId: hid,
      candidates: order.map((p) => p.candidate),
      client: client as never,
      gate,
      env: { ...env, PROPOSAL_PREVIEW: "on" },
      depsFor: (c) => {
        const arm = armOf.get(c.id);
        return { learn: arm?.learn ?? false, vision: !!arm?.vision && wantImages };
      },
      ...(wantImages
        ? {
            maxImagesPerCase: 4,
            visionFactory: ({ ticket, budget }) => {
              const v = makeRealVisionClient({ client: client as never, ticket, budget, model: gate.model, maxImages: 4 * cases.length, fetchImage: (u) => fetchPublicImage(u, { throttle, budget: runBudget }), splitImage: splitPublicImage });
              visionStats = v.stats;
              return { vision: v.vision, halted: () => v.stats().halted };
            },
          }
        : {}),
      lockPath: `${DIR}/.compare.lock`,
      onEvent,
    });
    const results: Record<string, unknown> = {};
    for (const e of exps) {
      const r = await scoreExperiment({ db: db as unknown as Db, experiment: e, prepared: prepared.filter((p) => p.arm.experiment === e), gold, modes: ["real"] });
      results[e] = { verdict: r.comparison.verdict, claim: r.claim, reasons: r.comparison.reasons, deltas: r.comparison.deltas, paired: r.comparison.paired, cases: r.comparison.cases, required: r.comparison.required, goldLeak: r.goldLeak };
    }
    writeFileSync(`${DIR}/result.local.json`, JSON.stringify({ at: new Date().toISOString(), summary, vision: typeof visionStats === "function" ? (visionStats as () => unknown)() : null, results }, null, 1));
    console.log("RESULT", JSON.stringify({ stopReason: summary.stopReason, processed: summary.processed, costJpy: summary.costJpy, overruns: summary.overruns, verdicts: Object.fromEntries(Object.entries(results).map(([k, x]) => [k, (x as { verdict: string }).verdict])) }));
    expect(summary.costJpy).toBeLessThanOrEqual(Number(env.JUDGMENT_APPROVED_TOTAL_JPY) + 1); // 承認額＋1回分の最悪費用の範囲
    expect(CMP_HOST).toContain("eval-cmp");
  }, 7_200_000);
});
