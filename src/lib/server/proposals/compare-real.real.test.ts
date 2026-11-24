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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { checkJudgmentRealRun } from "@/lib/judgment/real-gate";
import { progressOf, type ReviewState } from "@/lib/gold-review/model";
import { composeR1Cases, pageCandidate, validatePageGold, worksheetMarkdown, type R1PageGold } from "@/lib/judgment/xsource/r1-worksheet";
import { assertNoGoldLeak, type DatasetKind, type RealPostCase, validateRealPostCases, armsOf, EXPERIMENTS, planComparison, splitCalibration, validateGold, type CompareCase, type ExperimentId, type GoldCase } from "@/lib/judgment/xsource/compare-eval";
import { HostThrottle, RunFetchBudget } from "@/lib/collector/fetch-control";
import { makeRealVisionClient, worstCaseVisionCallJpy } from "@/lib/judgment/xsource/vision-real";
import { fetchPublicImage } from "@/lib/server/images/image-fetch";
import { splitPublicImage } from "@/lib/server/images/split-adapter";
import type { Db } from "@/lib/server/lottery-service";
import { checkLedger, committedOf, finishRun, startRun, stageKeyOf, type Ledger } from "@/lib/judgment/xsource/spend-ledger";
import { preflightRun } from "@/lib/judgment/xsource/cost-preflight";
import { OUTPUT_MAX_TOKENS } from "@/lib/judgment/xsource/research-ai";
import { buildMetricsSnapshot, renderMetrics } from "@/lib/judgment/xsource/measured-metrics";
import { captureRealPosts, type CaptureRow } from "./real-post-capture";
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
/** 独立gold確認（開発専用の確認画面）の状態。保存があるのに未確認・要再確認が残っているときは、有料の試験・案件の組み立てを止める */
const reviewIncomplete = (): string | null => {
  const st = read<ReviewState>(`${DIR}/gold-review.local.json`);
  if (!st) return null;
  const p = progressOf(st.pages);
  return p.complete ? null : `独立gold確認が完了していません（未確認 ${p.unreviewed}・要再確認 ${p.needs_recheck}・確認済み ${p.confirmed}・除外 ${p.excluded}）`;
};
/** データセット: 合成（実在ページ×合成投稿・構造の検証用）と実投稿（実在のX投稿・出所つき）は別のファイル・別の結果。既定は合成（PHASE2_CMP_DATASET=real で実投稿） */
const DATASET: DatasetKind = env.PHASE2_CMP_DATASET === "real" ? "real_post" : "synthetic_lp";
const FILES = DATASET === "real_post" ? { cases: "cases.real.local.json", gold: "gold.real.local.json" } : { cases: "cases.synthetic.local.json", gold: "gold.synthetic.local.json" };
const load = (): { cases: CompareCase[]; gold: GoldCase[]; sample: boolean } => {
  const cases = read<CompareCase[]>(`${DIR}/${FILES.cases}`);
  const gold = read<GoldCase[]>(`${DIR}/${FILES.gold}`);
  // 実AIで試験するのは、独立goldのある案件だけ（goldの無い案件は採点できず、費用だけがかかる）
  if (cases && gold) {
    // 価値の高い案件（goldの応募機会が多い＝取りこぼし・取り違えを測りやすい）から順に並べる。段階実行は --case-from / --case-limit で、この順の範囲を指定する
    const oppsOf = (id: string) => gold.find((g) => g.caseId === id)?.opportunities.length ?? 0;
    const ranked = cases.filter((c) => gold.some((g) => g.caseId === c.caseId)).sort((a, b) => oppsOf(b.caseId) - oppsOf(a.caseId) || a.caseId.localeCompare(b.caseId));
    const from = Math.max(0, Number(env.PHASE2_CMP_CASE_FROM) || 0);
    const limit = Number(env.PHASE2_CMP_CASE_LIMIT) || ranked.length;
    return { cases: ranked.slice(from, from + limit), gold, sample: false };
  }
  return { cases: read<CompareCase[]>(`${DIR}/sample/cases.json`) ?? [], gold: read<GoldCase[]>(`${DIR}/sample/gold.json`) ?? [], sample: true };
};
const CAPS = () => ({ totalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY) || Number(env.PHASE2_CMP_TOTAL_JPY) || 60, perCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) || Number(env.PHASE2_CMP_PER_CASE_JPY) || 5, maxImagesPerCase: 4, maxFetchPerCase: 30, maxMinutes: 120 });
/** 予算の完走見込み（保証ではない）。期待費用・1回の最大予約額・上限から、全件を完走できるか／保証できる件数／段階実行の案を出す */
const feasibilityOf = (runs: number, expectedJpy: number, cases: CompareCase[], gold: GoldCase[]) => {
  const totalCap = CAPS().totalJpy;
  const perRunMaxReserved = 3.6; // 調査4ターン×0.6 + 判断2回×0.6（readiness の事前検査と同じ設定）
  const perRunExpected = runs ? expectedJpy / runs : 0;
  const guaranteedRuns = Math.floor(totalCap / perRunMaxReserved);
  const armsPerCase = cases.length ? runs / cases.length : 2;
  const opps = (id: string) => gold.find((g) => g.caseId === id)?.opportunities.length ?? 0;
  const stages: { stage: string; cases: number; opportunities: number; expectedJpy: number }[] = [];
  const size = Math.max(1, Math.ceil(cases.length / 3));
  for (let i = 0; i < cases.length; i += size) {
    const part = cases.slice(i, i + size);
    stages.push({ stage: `案件${i + 1}〜${i + part.length}（価値の高い順）`, cases: part.length, opportunities: part.reduce((n, c) => n + opps(c.caseId), 0), expectedJpy: Math.round(part.length * armsPerCase * perRunExpected * 100) / 100 });
  }
  return { totalCapJpy: totalCap, expectedJpy, expectedShareOfCap: totalCap ? Math.round((expectedJpy / totalCap) * 1000) / 1000 : null, perRunExpectedJpy: Math.round(perRunExpected * 1000) / 1000, perRunMaxReservedJpy: perRunMaxReserved, guaranteedCompleteRuns: guaranteedRuns, plannedRuns: runs, guaranteedToComplete: runs <= guaranteedRuns, note: runs <= guaranteedRuns ? "最大予約額で数えても全回を完走できる" : `最大予約額で数えると ${guaranteedRuns} 回（${Math.floor(guaranteedRuns / Math.max(1, armsPerCase))} 案件）までしか保証できない。期待費用が上限の ${totalCap ? Math.round((expectedJpy / totalCap) * 100) : 0}% に収まる見込みだが、完走は保証しない（途中で予算に達した場合は、処理済みの案件だけで判定し、改善は主張しない）`, stages };
};
const planOf = (cases: CompareCase[], gold: GoldCase[], model = "claude-haiku-5-5") => {
  const avgImages = cases.length ? cases.reduce((n, c) => n + Math.min(4, c.imageRefs.length), 0) / cases.length : 0;
  const avgItems = cases.length ? Math.max(1, Math.round(cases.reduce((n, c) => n + Math.max(1, c.pages.length), 0) / cases.length)) : 3;
  const image = worstCaseVisionCallJpy(model, [{ width: 1200, height: 1600 }]);
  return planComparison({ experiments: experiments(), cases: cases.length, itemsPerCase: avgItems, imagesPerCase: Math.round(avgImages * 10) / 10, model, avgJpy: { agentTurn: 0.163, judge: 0.148, image: Number.isFinite(image) ? image : 0.15 }, turnsPerItem: 2, judgesPerItem: 1.3, caps: CAPS(), goldCases: gold.length });
};

describe.skipIf(!["plan", "mock", "export-cases", "gold-template", "r1-worksheet", "r1-build", "real-validate", "real-posts-scan", "real-posts-expand", "readiness", "run"].includes(MODE ?? "") || env.PHASE2_COMPARE !== "1")("Phase 2 同条件比較試験（評価入口）", () => {
  it("plan: 実行前の計画（無課金）", () => {
    if (MODE !== "plan") return;
    const { cases, gold, sample } = load();
    const v = validateGold(gold);
    const p = planOf(cases, gold);
    const feas = feasibilityOf(p.runs, p.expectedJpy, cases, gold);
    const led = read<Ledger>(`${DIR}/spend-ledger.local.json`) ?? { runs: [] };
    const ledgerInfo = { runs: led.runs.length, ...committedOf(led), note: "通算上限は実行時に --program-cap-jpy で利用者が指定。台帳は実行ごとの承認額・実費を記録し、上限超過・同じ段階の二重実行・未終了の実行を開始前に拒否する" };
    const goldOpps = gold.flatMap((g) => g.opportunities);
    const evaluation = {
      dataset: DATASET,
      claim: DATASET === "real_post" ? "実AIの結果だけが精度の根拠になりうる。ただし4案件・1サイト（livepocket.jp）のため一般化できず、改善は断言できない" : "構造確認のみ（精度として主張しない）",
      caseOrder: cases.map((c, i) => ({ order: i + 1, caseId: c.caseId, pages: c.pages.length, goldOpportunities: gold.find((g) => g.caseId === c.caseId)?.opportunities.length ?? 0 })),
      goldOpportunities: goldOpps.length,
      negativeExamples: goldOpps.filter((o) => o.decision !== "register").length,
      timeScoring: { goldWithTime: goldOpps.filter((o) => o.applyEndTime).length, population: goldOpps.filter((o) => o.applyEnd && o.applyEndTime).length, note: "時刻の母数が0なら、時刻の正解率は未測定（日付・年の採点は進められる）" },
      metrics: ["応募機会の見落とし（再現率）", "誤登録（goldで登録しない機会を登録・gold以外の登録案の混入は適合率で測る）", "異店舗・別抽選の混同（誤統合・誤分割・他の機会のページの引用の混入）", "根拠（引用の実在・混入・読み飛ばし段階）", "締切（日付・時刻・年）", "応募単位・URL・登録の判断"],
      limits: ["gold の登録しない例（decision≠register）が" + goldOpps.filter((o) => o.decision !== "register").length + "件のため、誤登録率は『goldで登録すべきでない機会を登録した』形では測れない。gold以外の登録案は適合率（unmatched）で見る", "製品と無関係なページ（SNS・短縮・危険ドメイン等）は取得段階で除外済み。評価用ページにはいずれも抽選の語がある（無関係ページへの耐性は未測定）"],
    };
    console.log("PLAN", JSON.stringify({ evaluation, feasibility: feas, ledger: ledgerInfo, input: sample ? "架空のサンプル（仕組みの確認用。実AIの実行には使えない）" : "ローカルの実データ", experiments: experiments(), cases: cases.length, goldCases: gold.length, goldValid: v.ok, goldErrors: v.errors.slice(0, 5), arms: experiments().flatMap((e) => armsOf(e).map((a) => `${a.id}（${a.label}）`)), questions: Object.fromEntries(experiments().map((e) => [e, EXPERIMENTS[e].question])), plan: p }));
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
    writeFileSync(`${DIR}/cases.export.local.json`, JSON.stringify(cases, null, 1)); // 実投稿のデータセットにするには、出所（provenance）を付けて cases.real.local.json に保存する
    console.log("EXPORTED", JSON.stringify({ cases: cases.length }));
    expect(cases.length).toBeGreaterThan(0);
  });

  it("gold-template: 人が記入する gold の下書き（AI出力を含めない）", () => {
    if (MODE !== "gold-template") return;
    const cases = read<CompareCase[]>(`${DIR}/cases.export.local.json`) ?? [];
    expect(cases.length).toBeGreaterThan(0);
    writeFileSync(`${DIR}/gold-template.local.json`, JSON.stringify(goldTemplate(cases), null, 1));
    console.log("TEMPLATE", JSON.stringify({ cases: cases.length, next: "記入後、gold の配列だけを eval/phase2-compare/gold.real.local.json に保存する" }));
  });

  it("r1-worksheet: 保存済みの実在の公開ページ（LivePocket）から、人が独立goldを確認するための資料を作る（AI出力を含めない）", () => {
    if (MODE !== "r1-worksheet") return;
    const dir = "eval/real-data/10t-html";
    const idx = JSON.parse(readFileSync(`${dir}/index.json`, "utf8")) as { n: number; url: string; ok: boolean }[];
    const pages = idx.filter((x) => x.ok).map((x) => ({ n: x.n, url: x.url, html: readFileSync(`${dir}/lp-${x.n}.html`, "utf8") }));
    const cands = pages.map(pageCandidate);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(`${DIR}/r1-worksheet.local.md`, worksheetMarkdown(cands));
    const skeleton: R1PageGold[] = cands.map((c) => ({ n: c.n, verified: { by: "human", at: "", basis: "" }, store: c.storeCandidate ?? "", product: (c.productCandidate ?? "").replace(/^\d{1,2}\/\d{1,2}[(（][^)）]*[)）]発売\s*/, ""), applyEnd: c.applyEndGuess?.year ? `${c.applyEndGuess.year}-${c.applyEndGuess.md.split("/").map((x) => x.padStart(2, "0")).join("-")}` : null /* 年が書かれていない締切は、年を補わない */, applyUnit: null, region: null, evidence: c.applyEndGuess ? [{ quote: c.applyEndGuess.quote }] : [] }));
    writeFileSync(`${DIR}/r1-gold-pages.template.local.json`, JSON.stringify(skeleton, null, 1));
    console.log("R1_WORKSHEET", JSON.stringify({ pages: pages.length, recognized: cands.filter((c) => c.recognized).length, withStore: cands.filter((c) => c.storeCandidate).length, withDeadlineCandidate: cands.filter((c) => c.deadlineCandidates.length).length, needAttention: cands.filter((c) => c.attention.length).length, next: "r1-worksheet.local.md を見て、r1-gold-pages.template.local.json を記入し r1-gold-pages.local.json として保存" }));
    expect(pages.length).toBeGreaterThan(0);
  });

  it("r1-build: 人が確認したページ単位のgoldから、R1の比較用の案件とgoldを組み立てる", () => {
    if (MODE !== "r1-build") return;
    const dir = "eval/real-data/10t-html";
    const idx = JSON.parse(readFileSync(`${dir}/index.json`, "utf8")) as { n: number; url: string; ok: boolean }[];
    const pages = idx.filter((x) => x.ok).map((x) => ({ n: x.n, url: x.url, html: readFileSync(`${dir}/lp-${x.n}.html`, "utf8") }));
    const inc = reviewIncomplete();
    if (inc) throw new Error(`実行しません: ${inc}`);
    const g = read<R1PageGold[]>(`${DIR}/r1-gold-pages.local.json`);
    if (!g) throw new Error("実行しません: r1-gold-pages.local.json（人が確認した gold）がありません。確認画面（/dev/gold-review）で確認して「R1用のgoldを書き出す」を押してください");
    const v = validatePageGold(g, pages);
    if (!v.ok) throw new Error(`実行しません: gold が条件を満たしていません: ${v.errors.slice(0, 3).join(" / ")}`);
    const out = composeR1Cases({ pages, gold: g, cases: Number(env.PHASE2_CMP_R1_CASES) || 12, linksPerCase: 3, at: new Date().toISOString() });
    const gv = validateGold(out.gold);
    if (!gv.ok) throw new Error(`実行しません: ${gv.errors.slice(0, 3).join(" / ")}`);
    writeFileSync(`${DIR}/cases.synthetic.local.json`, JSON.stringify(out.cases, null, 1)); // 合成データセット（構造の検証用。精度の主張には使わない）
    writeFileSync(`${DIR}/gold.synthetic.local.json`, JSON.stringify(out.gold, null, 1));
    console.log("R1_BUILT", JSON.stringify({ cases: out.cases.length, goldCases: out.gold.length, pagesUsed: g.filter((x) => !x.exclude).length }));
    expect(out.cases.length).toBeGreaterThan(0);
  });

  it("real-posts-scan: 保存済みの実投稿（過去に保存した抽出）から、複数リンクの実投稿の候補を数える（ネットワークなし・本文は標準出力に出さない）", () => {
    if (MODE !== "real-posts-scan") return;
    const dir = "eval/real-data";
    const f = readdirSync(dir).filter((x) => /^extract-.*\.json$/.test(x)).sort().at(-1);
    if (!f) {
      console.log("REAL_POSTS_SCAN", JSON.stringify({ present: false }));
      return;
    }
    const rows = (JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { rows: { id: string; evidence_text: string; evidence_url: string; evidence_via: string; evidence_fetched_at: string }[] }).rows;
    const cands: CaptureRow[] = rows.filter((r) => /^x_/.test(r.evidence_via) && /^https:\/\/(x|twitter)\.com\/\w+\/status\/\d+/.test(r.evidence_url) && new Set(r.evidence_text.match(/https:\/\/t\.co\/[A-Za-z0-9]+/g) ?? []).size >= 2).map((r) => ({ id: r.id, postUrl: r.evidence_url.split("?")[0], text: r.evidence_text, capturedAt: r.evidence_fetched_at }));
    mkdirSync(DIR, { recursive: true });
    writeFileSync(`${DIR}/real-post-candidates.local.json`, JSON.stringify(cands, null, 1));
    const shorts = cands.map((c) => new Set(c.text.match(/https:\/\/t\.co\/[A-Za-z0-9]+/g) ?? []).size);
    console.log("REAL_POSTS_SCAN", JSON.stringify({ present: true, rows: rows.length, xPosts: rows.filter((r) => /^x_/.test(r.evidence_via)).length, multiLinkPosts: cands.length, shortLinks: shorts.reduce((a, b) => a + b, 0), maxPerPost: Math.max(0, ...shorts), expanded: 0, pagesSaved: 0, note: "短縮URLは未展開・リンク先の本文は保存されていない（展開と取得には実ネットワークへの許可が必要: real-posts-expand）" }));
  });

  it("real-posts-expand: 【実ネットワークを伴う・明示の許可が必要】短縮URLの展開（公開のリダイレクト先を読むだけ）とリンク先の公開ページの取得。無課金・robots/SSRF対策・ホスト別間隔・総数上限つき", async () => {
    if (MODE !== "real-posts-expand") return;
    if (env.PHASE2_REAL_EXPAND !== "allow") throw new Error("実行しません: 第三者サイトへの実アクセスを伴うため、利用者の許可（--allow-network）が必要です");
    const cands = read<CaptureRow[]>(`${DIR}/real-post-candidates.local.json`);
    if (!cands?.length) throw new Error("実行しません: 先に real-posts-scan を実行してください");
    const max = Math.min(150, Number(env.PHASE2_REAL_EXPAND_MAX) || 150); // 許可された範囲（最大150リクエスト）を超えない
    const { cases, pages, report } = await captureRealPosts({ rows: cands, maxRequests: max });
    writeFileSync(`${DIR}/cases.real.local.json`, JSON.stringify(cases, null, 1));
    writeFileSync(`${DIR}/real-pages.local.json`, JSON.stringify(pages, null, 1)); // 取得したページ（出所・取得日時・ハッシュ・本文。Git管理外）
    writeFileSync(`${DIR}/real-capture-report.local.json`, JSON.stringify(report, null, 1));
    console.log("REAL_POSTS_EXPAND", JSON.stringify({ withMultiLinks: report.withMultiLinks, processed: report.processed, built: report.built, pages: pages.length, requests: report.requests, bytes: report.bytes, shortLinks: report.shortLinks, failures: report.failures, shortenerRobots: report.shortenerRobots, stoppedBy: report.stoppedBy, elapsedMs: report.elapsedMs }));
  }, 1_800_000);

  it("readiness: 実AI試験（R1）を始められる状態かの判定（無課金・読み取りだけ）。ブロッカー（人の確認・承認待ちなど）と警告を出す。承認の値は一切代入しない", () => {
    if (MODE !== "readiness") return;
    const blockers: string[] = [];
    const warnings: string[] = [];
    const ok: string[] = [];
    // 1) 独立gold確認の状態（人の確認）
    const lp = read<ReviewState>(`${DIR}/gold-review.local.json`);
    const real = read<ReviewState>(`${DIR}/gold-review-real.local.json`);
    const lpP = lp ? progressOf(lp.pages) : null;
    if (!lpP) blockers.push("独立gold確認（LivePocket 12ページ）が未着手です（/dev/gold-review）");
    else if (!lpP.complete) blockers.push(`独立gold確認が完了していません（未確認 ${lpP.unreviewed}・要再確認 ${lpP.needs_recheck}・確認済み ${lpP.confirmed}・除外 ${lpP.excluded}）`);
    else ok.push(`独立gold確認（LivePocket）が完了（確認済み ${lpP.confirmed}・除外 ${lpP.excluded}）`);
    const realP = real ? progressOf(real.pages) : null;
    if (!realP) warnings.push("実投稿のリンク先の確認は未着手です（実投稿R1は別途。合成R1とは別の結果）");
    else ok.push(`実投稿のgold確認: 確認済み ${realP.confirmed}・除外 ${realP.excluded}・未確認 ${realP.unreviewed}・要再確認 ${realP.needs_recheck}`);
    // 2) 入力と gold（合成データセット）
    const cases = read<CompareCase[]>(`${DIR}/cases.synthetic.local.json`);
    const gold = read<GoldCase[]>(`${DIR}/gold.synthetic.local.json`);
    if (!cases || !gold) blockers.push("R1の入力（cases.synthetic.local.json・gold.synthetic.local.json）が未作成です（gold確認の完了後に r1-build）");
    else {
      const v = validateGold(gold);
      if (!v.ok) blockers.push(`goldの独立性の検査に失敗: ${v.errors.slice(0, 2).join(" / ")}`);
      else ok.push(`gold ${gold.length}案件が独立性の検査に合格（人の確認・根拠の引用・合言葉）`);
      const leak = assertNoGoldLeak(cases.flatMap((c) => [c.postText, ...c.pages.map((p) => p.text)]), gold);
      if (!leak.ok) blockers.push("AIへ渡す入力に、gold の合言葉が混ざっています");
      else ok.push("AIへの入力に gold の合言葉が混ざっていない");
    }
    // 3) 費用の最悪予約（承認額ではなく、関門の上限＝最大で見た場合）
    const model = "claude-haiku-5-5";
    const n = cases?.length ?? 12;
    // 案件が未作成のときは、R1の想定（12案件・各3ページ）で見積もる
    const placeholder: CompareCase[] = Array.from({ length: 12 }, (_, i) => ({ caseId: `ph${i}`, postText: "", links: [], linkMap: [], pages: [1, 2, 3].map((k) => ({ url: `https://ph.example.invalid/${k}`, text: "x" })), imageRefs: [], imageReadings: [] }));
    const plan = planOf(cases ?? placeholder, gold ?? [], model);
    const limits = { maxTurns: 4, maxSearches: 0, maxRevisions: 1, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, searchReserveJpy: 2.5 };
    const pf = preflightRun({ model, totalJpy: 60, perCaseJpy: 5, cases: n, limits, maxInputTokens: 24_000, maxOutputTokens: OUTPUT_MAX_TOKENS, gatePerCaseCapJpy: 5 });
    if (!pf.ok) blockers.push(`費用の事前検査に失敗: ${pf.errors.join(", ")}`);
    else ok.push(`費用の事前検査に合格（1件の最小予約 ${pf.minPerCaseJpy}円・最大予約 ${pf.maxReservedPerCaseJpy}円・1回の最悪 ${pf.worstCaseCallJpy}円・予約が最悪以上: ${pf.reservationCoversWorstCase}）`);
    if (!pf.reservationCoversWorstCase) warnings.push("予約額が1回の最悪費用より小さい設定があります（承認額を1回分超えうる）");
    // 4) 承認の値が事前に入っていないこと（偽造・代理入力の防止）
    for (const k of ["JUDGMENT_APPROVED_TOTAL_JPY", "JUDGMENT_APPROVED_PER_CASE_JPY", "JUDGMENT_REAL_CONFIRM", "JUDGMENT_REAL_EVAL"]) if (env[k]) blockers.push(`承認に関する環境変数 ${k} が設定されています（実行時に利用者が指定する値です。事前に設定しない）`);
    if (!env.PHASE2_CMP_TOTAL_JPY) ok.push("承認額は未設定（承認文は実行時に利用者が指定する）");
    // 5) 実測指標
    const cap = read<{ requests: { total: number }; shortLinks: { total: number; resolved: number }; built: number }>(`${DIR}/real-capture-report.local.json`);
    const metrics = buildMetricsSnapshot({ capture: cap ? { shortTotal: cap.shortLinks.total, shortResolved: cap.shortLinks.resolved, casesBuilt: cap.built } : null, gold: gold ? { cases: gold.length, opportunities: gold.reduce((a, g) => a + g.opportunities.length, 0) } : null, review: lp ? { total: lp.pages.length, unreviewed: lp.pages.filter((p) => p.status !== "confirmed" && p.status !== "excluded").length } : null, historyViolations: null });
    console.log("READINESS", JSON.stringify({ readyForApproval: blockers.length === 0, blockers, warnings, ok, plan: { experiments: experiments(), cases: n, expectedJpy: plan.expectedJpy, apiCalls: plan.apiCalls, caps: "関門の上限（総額60円・1件5円）を最大として見た場合。承認額ではありません", approvalPhrase: "実行時に利用者が指定します（金額は利用者が決める）" } }));
    console.log("METRICS\n" + renderMetrics(metrics));
    expect(Array.isArray(blockers)).toBe(true);
  });

  it("real-validate: 実投稿のデータセット（cases.real.local.json・gold.real.local.json）の出所・複数リンク・goldの独立性を検査する", () => {
    if (MODE !== "real-validate") return;
    const cases = read<RealPostCase[]>(`${DIR}/cases.real.local.json`);
    const gold = read<GoldCase[]>(`${DIR}/gold.real.local.json`);
    if (!cases) {
      console.log("REAL_VALIDATE", JSON.stringify({ present: false, note: "実投稿のデータセットはありません（実例が揃っていません。合成の結果を実投稿の結果として扱わない）" }));
      return;
    }
    const v = validateRealPostCases(cases);
    const g = gold ? validateGold(gold) : { ok: false, errors: ["gold.real.local.json がありません"] };
    console.log("REAL_VALIDATE", JSON.stringify({ present: true, cases: cases.length, casesValid: v.ok, goldValid: g.ok, errors: [...v.errors, ...g.errors].slice(0, 6) }));
    expect(v.ok && g.ok).toBe(true);
  });

  it("mock: 台本のAI（費用0）で全経路を通す。結果は精度ではない", async () => {
    if (MODE !== "mock") return;
    const db = admin();
    const { data: hh } = await db.from("households").select("id").limit(1).maybeSingle();
    const { cases, gold, sample } = load();
    const out: Record<string, unknown> = {};
    for (const e of experiments()) {
      const r = await runExperimentMock({ db: db as unknown as Db, householdId: hh!.id, experiment: e, cases, gold, dataset: DATASET, env: { ...env, PROPOSAL_PREVIEW: "on" } });
      out[e] = { verdict: r.comparison.verdict, claim: r.claim, cases: r.comparison.cases, required: r.comparison.required, paired: r.comparison.paired, goldLeak: r.goldLeak.ok, reasons: r.comparison.reasons };
    }
    console.log("MOCK", JSON.stringify({ input: sample ? "sample" : "local", ...out }));
    expect(Object.keys(out)).toHaveLength(experiments().length);
  }, 600_000);

  it("run: 実AI（有料・承認後）。関門・事前検査・独立goldの検証・停止条件つき", async () => {
    if (MODE !== "run") return;
    const { cases, gold, sample } = load();
    const inc = reviewIncomplete();
    if (inc) throw new Error(`実行しません: ${inc}`);
    if (DATASET === "real_post") {
      const rv = validateRealPostCases(cases as RealPostCase[]);
      if (!rv.ok) throw new Error(`実行しません: 実投稿のデータセットが条件を満たしていません: ${rv.errors.slice(0, 3).join(" / ")}`);
    }
    if (sample) throw new Error("実行しません: 架空のサンプルでは実AIを実行しない（cases.local.json と、人が作った gold.local.json が必要）");
    const v = validateGold(gold);
    if (!v.ok) throw new Error(`実行しません: gold が独立した人の確認の条件を満たしていません: ${v.errors.slice(0, 3).join(" / ")}`);
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const plan = planOf(cases, gold, gate.model);
    if (!plan.withinCap) throw new Error(`実行しません: 計画の期待費用 ${plan.expectedJpy}円が承認額 ${plan.warnings.join(" / ")}`);
    // 費用の通算台帳: 関門の上限は1回の実行ごとにリセットされるため、利用者が選んだ「通算上限」を超える実行は開始前に拒否する
    const ledgerPath = `${DIR}/spend-ledger.local.json`;
    const ledger0 = read<Ledger>(ledgerPath) ?? { runs: [] };
    const stageKey = stageKeyOf({ dataset: DATASET, experiments: experiments(), from: Math.max(0, Number(env.PHASE2_CMP_CASE_FROM) || 0), limit: Number(env.PHASE2_CMP_CASE_LIMIT) || null });
    const lc = checkLedger({ ledger: ledger0, programCapJpy: Number(env.PHASE2_PROGRAM_CAP_JPY), approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), stageKey, allowRerun: env.PHASE2_RERUN_STAGE === "1" });
    if (!lc.ok) throw new Error(`実行しません（費用の通算台帳）: ${lc.errors.join(" / ")}`);
    const runId = `run-${Date.now()}`;
    mkdirSync(DIR, { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify(startRun(ledger0, { id: runId, stageKey, startedAt: new Date().toISOString(), approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) }), null, 1));
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
    const rank = new Map(cases.map((c, i) => [c.caseId, i]));
    const order = [...prepared].sort((a, b) => (rank.get(a.caseId) ?? 0) - (rank.get(b.caseId) ?? 0) || a.arm.experiment.localeCompare(b.arm.experiment) || a.arm.role.localeCompare(b.arm.role));
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
    // 実費を台帳に記録する（この行が無い＝異常終了した実行は、承認額の満額を使ったものとして通算に数えられる）
    writeFileSync(ledgerPath, JSON.stringify(finishRun(read<Ledger>(ledgerPath) ?? ledger0, runId, summary.costJpy, new Date().toISOString()), null, 1));
    const results: Record<string, unknown> = {};
    for (const e of exps) {
      const r = await scoreExperiment({ dataset: DATASET, householdId: hid, db: db as unknown as Db, experiment: e, prepared: prepared.filter((p) => p.arm.experiment === e), gold, modes: ["real"] });
      results[e] = { dataset: r.dataset, verdict: r.comparison.verdict, claim: r.claim, reasons: r.comparison.reasons, deltas: r.comparison.deltas, paired: r.comparison.paired, cases: r.comparison.cases, required: r.comparison.required, goldLeak: r.goldLeak, readAudit: r.readAudit, limitAudit: { level: r.limitAudit.level, messages: r.limitAudit.messages, candidates: r.limitAudit.report.candidates, pages: r.limitAudit.report.pages, hitCandidates: r.limitAudit.report.hitCandidates, notes: r.limitAudit.report.notes } };
    }
    writeFileSync(`${DIR}/result.local.json`, JSON.stringify({ at: new Date().toISOString(), summary, vision: typeof visionStats === "function" ? (visionStats as () => unknown)() : null, results }, null, 1));
    console.log("RESULT", JSON.stringify({ stopReason: summary.stopReason, processed: summary.processed, costJpy: summary.costJpy, overruns: summary.overruns, verdicts: Object.fromEntries(Object.entries(results).map(([k, x]) => [k, (x as { verdict: string }).verdict])) }));
    expect(summary.costJpy).toBeLessThanOrEqual(Number(env.JUDGMENT_APPROVED_TOTAL_JPY) + 1); // 承認額＋1回分の最悪費用の範囲
    expect(CMP_HOST).toContain("eval-cmp");
  }, 7_200_000);
});
