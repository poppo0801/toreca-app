// @vitest-environment node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildThreewaySet, casesFromRunFiles, scoreThreeway, viewFromInput, type AnswerResult, type Arm, type RunCaseFile } from "./threeway-review";
import { computeMetrics, selectForReview, triageCase, type CaseFact } from "./metrics-9h3k";

/**
 * Stage 9H-3K: 実行結果 → 案件ごとの処理結果・指標・人間評価セット（通常のテストでは実行されない）。
 *   作成:  BUILD_9H3K=1 npx vitest run src/lib/case-model/build-9h3k-report.test.ts
 *   採点:  BUILD_9H3K=1 SCORE_ANSWERS=backups/review-answers/<評価結果>.json npx vitest run src/lib/case-model/build-9h3k-report.test.ts
 * 出力（backups/eval-9h3k/。Git管理外）: report-9h3k.json（案件ごとの処理結果・指標）・review-set-9h3k.json・review-key-9h3k.json（評価が終わるまで開かない）
 * 評価に回すのは、誤登録リスク・情報不足/隔離・方式間の食い違い（全件）と、通常の案件からの無作為抽出。評価していない案件は正解として集計しない。
 */
const ON = process.env.BUILD_9H3K === "1";
const OUT = "backups/eval-9h3k";

type SavedCase = RunCaseFile & {
  outcome?: string;
  costJpy?: number;
  startedAt: string;
  members: { id: string; url: string | null; title: string; input?: { store?: string } }[];
  investigation: (RunCaseFile["investigation"] & { result: { stopReason?: string | null } }) | null;
};

describe.skipIf(!ON || !existsSync(`${OUT}/plan.json`))("9H-3K 案件ごとの処理結果・指標・評価セット（実データ）", () => {
  it("実行結果から、案件ごとの処理結果・指標・人間評価セットを作る", () => {
    const plan = JSON.parse(readFileSync(`${OUT}/plan.json`, "utf8")) as { digest: string; cases: { caseId: string; patterns: string[]; baseline: { sourceUrl: string | null; sourceTitle: string } }[] };
    const qf = `${OUT}/quarantine.json`;
    const quarantine = (existsSync(qf) ? JSON.parse(readFileSync(qf, "utf8")) : {}) as Record<string, { reasons: string[] }>;
    const rc = existsSync(`${OUT}/region-conditions.json`) ? JSON.parse(readFileSync(`${OUT}/region-conditions.json`, "utf8")) : null;
    const latest = new Map<string, SavedCase>();
    for (const run of readdirSync(`${OUT}/runs`).sort()) {
      for (const f of readdirSync(`${OUT}/runs/${run}`).filter((x) => x.startsWith("case-"))) {
        const j = JSON.parse(readFileSync(`${OUT}/runs/${run}/${f}`, "utf8")) as SavedCase;
        if ((j.arms && !j.error) || quarantine[j.caseId]) latest.set(j.caseId, j);
      }
    }
    const facts: CaseFact[] = [...latest.values()].map((f) => {
      const arms = f.arms;
      const views = { A: viewFromInput(arms?.A.input), B: viewFromInput(arms?.B.input), C: viewFromInput(arms?.C.input) } as CaseFact["views"];
      return {
        caseId: f.caseId,
        outcome: f.outcome === "region_excluded" ? "region_excluded" : f.error ? "error" : "processed",
        quarantineReasons: quarantine[f.caseId]?.reasons ?? null,
        patterns: f.patterns,
        views,
        cards: { A: arms?.A.openCards ?? 0, B: arms?.B.openCards ?? 0, C: arms?.C.openCards ?? 0 },
        provenance: arms?.C.provenance ?? null,
        formState: arms?.C.formJudgment?.state ?? null,
        formBasis: (arms?.C.formJudgment as { basis?: string[] } | null | undefined)?.basis?.[0] ?? null,
        memberStores: f.members.map((m) => (m as { input?: { store?: string } }).input?.store ?? ""),
        stopReason: f.investigation?.result.stopReason ?? null,
        costJpy: f.costJpy ?? 0,
      };
    });
    const sel = selectForReview(facts, { setId: `rs-9h3k-${plan.digest}` });
    const reviewFiles = [...latest.values()].filter((f) => sel.selected.includes(f.caseId));
    const cases = casesFromRunFiles(reviewFiles, (id) => {
      const c = plan.cases.find((x) => x.caseId === id);
      return { url: c?.baseline.sourceUrl ?? "", title: c?.baseline.sourceTitle ?? id };
    }, { quarantine });
    const TRIAGE_JA: Record<string, string> = { risk: "誤登録リスクあり", insufficient: "情報不足・隔離", disagree: "方式間で判断が分かれた", normal: "通常（無作為抽出）" };
    for (const c of cases) c.patternLabels = [`評価の優先度: ${TRIAGE_JA[sel.triage[c.caseId].triage] ?? ""}（${sel.triage[c.caseId].reasons.join(" / ").slice(0, 90) || "危険信号なし"}）`, ...c.patternLabels];
    const note = `この評価は、本番相当の地域条件（${rc ? `${(rc.prefectures as string[]).join("・")}。${rc.source === "production_settings" ? "本番の収集設定" : "本番の判定記録からの推定"}` : "未記録"}）で実行しています。優先度の高い案件（誤登録リスク・情報不足・隔離・方式間の食い違い）と、通常の案件からの無作為抽出だけを載せています。載せていない案件は正解として集計していません`;
    const build = buildThreewaySet(cases, { setId: `rs-9h3k-${plan.digest}`, note });
    writeFileSync(`${OUT}/review-set-9h3k.json`, JSON.stringify(build.set, null, 1));
    writeFileSync(`${OUT}/review-key-9h3k.json`, JSON.stringify({ note: "評価が終わるまで開かない", key: build.key }, null, 1));
    let score = null as ReturnType<typeof scoreThreeway> | null;
    if (process.env.SCORE_ANSWERS) {
      const ans = JSON.parse(readFileSync(process.env.SCORE_ANSWERS, "utf8")) as { results: AnswerResult[] };
      score = scoreThreeway(ans.results, build, cases);
    }
    const metrics = computeMetrics({ facts, planned: plan.cases.length, score, reviewed: sel.selected });
    const rows = facts.map((f) => {
      const c = latest.get(f.caseId)!;
      const t = sel.triage[f.caseId];
      const v = f.views.C;
      return {
        caseId: f.caseId,
        patterns: f.patterns,
        outcome: f.outcome,
        triage: t.triage,
        triageReasons: t.reasons,
        quarantine: f.quarantineReasons,
        forReview: sel.selected.includes(f.caseId),
        costJpy: f.costJpy,
        sourceUrls: [...new Set(c.members.map((m) => m.url).filter(Boolean))],
        finalUrls: [...new Set((c.investigation?.result as unknown as { sources?: { url: string; finalUrl?: string; status: string }[] } | undefined)?.sources?.filter((s) => s.status && s.finalUrl).map((s) => s.finalUrl) ?? [])],
        candidate: v ? { chain: v.chain, store: v.store, products: v.products, applyStart: v.applyStart, applyDeadline: v.applyDeadline, resultDate: v.resultDate, lotteryForm: v.lotteryForm, applyMethod: v.applyMethod, receiveMethod: v.receiveMethod } : null,
        provenance: f.provenance?.records ?? null,
        provenanceVerdict: f.provenance?.verdict ?? null,
        formState: f.formState,
        cards: f.cards,
        stopReason: f.stopReason,
      };
    });
    writeFileSync(`${OUT}/report-9h3k.json`, JSON.stringify({ digest: plan.digest, regionConditions: rc, metrics, review: { selected: sel.selected, notSelected: sel.notSelected }, humanScore: score, cases: rows }, null, 1));
    expect((build.set.cases as unknown[]).length).toBe(cases.length);
  });
});

describe("案件の優先度の分類（固定ロジック。正誤の判定ではない）", () => {
  const view = (o: Partial<NonNullable<CaseFact["views"]["C"]>> = {}) => ({ chain: "X", store: "渋谷店", products: ["拡張パック P"], applyStart: null, applyDeadline: "2026-11-20", resultDate: null, conditions: null, lotteryForm: null, receiveMethod: null, applyMethod: null, ...o });
  const base = (o: Partial<CaseFact> = {}): CaseFact => ({ caseId: "k", outcome: "processed", quarantineReasons: null, patterns: [], views: { A: view(), B: view(), C: view() }, cards: { A: 1, B: 1, C: 1 }, provenance: { verdict: "ok", records: [] }, formState: null, memberStores: ["渋谷店"], stopReason: null, costJpy: 1, ...o });
  it("地域除外は別枠（精度に含めない）。根拠が不十分・推定・別店舗の統合の疑いは誤登録リスク。取得制限・欠けは情報不足", () => {
    expect(triageCase(base({ outcome: "region_excluded" })).triage).toBe("region_excluded");
    expect(triageCase(base({ provenance: { verdict: "unsupported", records: [] } })).triage).toBe("risk");
    expect(triageCase(base({ formState: "estimated" })).triage).toBe("risk");
    expect(triageCase(base({ formState: "confirmed", formBasis: "AIの読み取り・調査から店舗選択式", provenance: { verdict: "ok", records: [{ support: "found_in_source", tier: "secondary" }] } })).triage).toBe("risk");
    expect(triageCase(base({ memberStores: ["渋谷店", "新宿店"] })).triage).toBe("risk");
    expect(triageCase(base({ quarantineReasons: ["x"] })).triage).toBe("insufficient");
    expect(triageCase(base({ views: { A: view(), B: view(), C: view({ products: [] }) } })).triage).toBe("insufficient");
    expect(triageCase(base({ stopReason: "blocked" })).triage).toBe("insufficient");
    expect(triageCase(base({ views: { A: view({ applyDeadline: "2026-11-18" }), B: view(), C: view() } })).triage).toBe("disagree");
    expect(triageCase(base()).triage).toBe("normal");
  });
  it("評価に回すのは危険信号・情報不足・食い違いの全件と、通常の案件の一部。選ばれなかった案件は正解として集計しない", () => {
    const facts = [base({ caseId: "a", memberStores: ["x", "y"] }), base({ caseId: "b", quarantineReasons: ["q"] }), ...["c", "d", "e", "f", "g"].map((id) => base({ caseId: id })), base({ caseId: "h", outcome: "region_excluded" })];
    const s = selectForReview(facts, { setId: "t", normalRate: 0.4, normalMin: 2 });
    expect(s.selected).toEqual(expect.arrayContaining(["a", "b"]));
    expect(s.selected.filter((x) => "cdefg".includes(x)).length).toBe(2);
    expect(s.selected).not.toContain("h");
    expect(s.notSelected.map((x) => x.caseId)).toContain("h");
    expect(selectForReview(facts, { setId: "t" }).selected).toEqual(s.selected);
  });
  it("人間の評価が無い指標は未確定。AIの判定を正解にしない", () => {
    const m = computeMetrics({ facts: [base(), base({ caseId: "k2", outcome: "region_excluded" })], planned: 3 });
    for (const k of ["normal_rate", "misregistration_risk", "miss_rate", "over_quarantine", "dedupe_accuracy"]) expect(m.indicators.find((x) => x.key === k)).toMatchObject({ status: "pending_human", rate: null });
    expect(m.counts).toMatchObject({ planned: 3, processed: 1, regionExcluded: 1, notRun: 1 });
    expect(m.indicators.find((x) => x.key === "cross_store_merge")?.status).toBe("proxy");
  });
});
void (null as unknown as Arm);
