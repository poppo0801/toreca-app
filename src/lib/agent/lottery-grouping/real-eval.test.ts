// @vitest-environment node
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnthropicAgentLLM } from "@/lib/agent/anthropic";
import { checkRealApi } from "@/lib/agent/real-gate";
import { GROUPING_SUBMIT, GROUPING_SUBMIT_STRICT_SCHEMA } from "@/lib/agent/lottery-grouping/proposal";
import { MockGroupingBrain } from "@/lib/agent/lottery-grouping/mock";
import { BudgetGuard, LedgerFetcher, datasetHashes, planRun, replayRecords, runCases, summarizeRuns, validateDataset, REAL_EVAL_LIMITS, type Exclusion, type LedgerPage, type RealCase, type RealGold, type RunRecord } from "@/lib/agent/lottery-grouping/real-eval";
import { DEFAULT_AI_MODEL } from "@/lib/ai-cost";

/**
 * 抽選グループ判定の実データ評価（Stage 8F-2）。
 *  - 通常のテスト: ロジック（検証・予算ガード・集計・再判定）を、モックAIと合成データで確認する。ネットワーク・API には接続しない。
 *  - 実行前の確認（REAL_GROUPING_PREFLIGHT=1）／凍結（REAL_GROUPING_FREEZE=1）／保存済みの再判定（REAL_GROUPING_REPLAY=1）／集計（REAL_GROUPING_REPORT=1）／
 *    実API（REAL_GROUPING_EVAL=1。scripts/eval-grouping-real.mjs 経由。承認された費用・実行回数の範囲のみ）。
 * データ: eval/lottery-grouping-real/{cases.json, gold.json, frozen.json}。結果: eval/runs/lottery-grouping-real/（Git管理外）。
 */
const DIR = "eval/lottery-grouping-real";
const OUT = "eval/runs/lottery-grouping-real";
/** 評価データの組（空=8F-2の17ケース。REAL_GROUPING_SET=8f3 で 8F-3 の新しい組）。組ごとに入力・正解・凍結が別ファイル。既存の組は変更しない */
const SET = process.env.REAL_GROUPING_SET ? `-${process.env.REAL_GROUPING_SET}` : "";
const read = (f: string): string => readFileSync(`${DIR}/${f.replace(".json", `${SET}.json`)}`, "utf8");
const have = existsSync(`${DIR}/cases${SET}.json`) && existsSync(`${DIR}/gold${SET}.json`);
const load = (): { cases: RealCase[]; gold: Record<string, RealGold>; casesText: string; goldText: string } => {
  const casesText = read("cases.json");
  const goldText = read("gold.json");
  return { cases: JSON.parse(casesText).cases as RealCase[], gold: JSON.parse(goldText).labels as Record<string, RealGold>, casesText, goldText };
};
const env = process.env;
const SET_KEY = env.REAL_GROUPING_SET || "8f2";
const exclusionsOf = (): Exclusion[] => (existsSync(`${DIR}/exclusions.json`) ? (JSON.parse(readFileSync(`${DIR}/exclusions.json`, "utf8")).exclusions as Exclusion[]).filter((e) => e.set === SET_KEY) : []);
/** 保存済みのページの台帳（実際に取得したページ。取得日時・ハッシュつき）。あれば、AIが fetch_source_page でここから根拠を集められる。評価でネットワークに出ない */
const ledgerOf = (): LedgerFetcher | undefined => (existsSync(`${DIR}/pages${SET}.json`) && env.REAL_GROUPING_FETCH !== "0" ? new LedgerFetcher((JSON.parse(readFileSync(`${DIR}/pages${SET}.json`, "utf8")).pages as LedgerPage[])) : undefined);
const model = env.AGENT_MODEL?.trim() || DEFAULT_AI_MODEL;

// ---------------------------------------------------------------- 合成データ（ロジックの検証用。実在の評価データではない）
const mk = (id: string, store: string, over: Record<string, unknown> = {}): RealCase["subject"] => ({ id, store, chain: "検証チェーン", products: ["検証商品"], start: "2026-12-01", deadline: "2026-12-07", result: "2026-12-10", urls: [`https://example.invalid/${id}`], ...over });
const mkCase = (id: string, category: RealCase["category"], subject: RealCase["subject"], others: RealCase["others"], evidence: Record<string, string> = {}): RealCase => ({ id, title: id, category, capturedAt: "2026-11-13T00:00:00Z", sources: [{ url: "https://example.invalid/s", fetchedAt: "2026-11-13T00:00:00Z" }], subject, others, evidence });
const basis = [{ kind: "official_announcement" as const, ref: "https://example.invalid/s", checkedAt: "2026-11-13" }];
const SYN: { cases: RealCase[]; gold: Record<string, RealGold> } = {
  cases: [
    mkCase("S1", "multi_store_same", mk("a1", "甲店"), [mk("a2", "乙店")], { a1: "『冬の検証企画』の抽選", a2: "『冬の検証企画』の抽選" }),
    mkCase("S2", "period_differs", mk("b1", "甲店"), [mk("b2", "乙店", { deadline: "2026-12-20" })]),
    mkCase("S3", "insufficient", mk("c1", "甲店"), [mk("c2", "乙店", { products: ["別商品"] })]),
    mkCase("S4", "duplicate_post", mk("d1", "単独店", { chain: "他チェーン" }), []), // 相手がいない（AIを呼ばない）
  ],
  gold: { S1: { label: "auto", basis }, S2: { label: "none", basis }, S3: { label: "unknown", basis: [], note: "確定できない" }, S4: { label: "none", basis } },
};

describe("実データ評価の基盤（モック・合成データ。ネットワークなし）", () => {
  it("データセットの検査: 根拠のない正解・入力に混ざった正解・情報源の欠落を検出する", () => {
    expect(validateDataset(SYN.cases, SYN.gold)).toEqual([]);
    expect(validateDataset(SYN.cases, { ...SYN.gold, S1: { label: "auto", basis: [] } }).join()).toMatch(/独立した根拠/);
    expect(validateDataset([{ ...SYN.cases[0], sources: [] }, ...SYN.cases.slice(1)], SYN.gold).join()).toMatch(/情報源/);
    const leaked = { ...SYN.cases[0], subject: { ...SYN.cases[0].subject, label: "auto" } } as unknown as RealCase;
    expect(validateDataset([leaked, ...SYN.cases.slice(1)], SYN.gold).join()).toMatch(/正解らしきキー/);
    expect(validateDataset(SYN.cases, { S1: SYN.gold.S1 }).join()).toMatch(/正解がありません/);
    expect(validateDataset(SYN.cases, { ...SYN.gold, S9: { label: "none", basis } }).join()).toMatch(/入力に無い正解/);
    expect(validateDataset([{ ...SYN.cases[0], category: "x" as never }, ...SYN.cases.slice(1)], SYN.gold).join()).toMatch(/分類/);
  });

  it("予算ガード: 残りが1ケースの上限に満たなければ開始しない（合計を超えない）・1ケースの上限は残りを超えない", () => {
    const g = new BudgetGuard(500, 15);
    expect(g.canStart().ok).toBe(true);
    expect(g.caseLimit()).toBe(15);
    g.record(490);
    expect(g.canStart()).toMatchObject({ ok: false });
    expect(g.caseLimit()).toBe(10);
    const g2 = new BudgetGuard(30, 15);
    g2.record(14.9);
    expect(g2.canStart().ok).toBe(true); // 残り15.1 ≥ 15
    g2.record(0.3);
    expect(g2.canStart().ok).toBe(false);
  });

  it("実行計画: 最悪ケースの費用を事前に計算し、保証される上限は合計500円以下。AIを呼ばないケースは数えない", () => {
    const p = planRun({ cases: SYN.cases, model: "claude-haiku-5-5", stabilityRepeats: 1 });
    expect(p.aiCases).toBe(2); // S3は商品が違い比較相手にならない・S4は相手がいない
    expect(p.maxRuns).toBe(4);
    expect(p.worstCaseJpy).toBe(4 * REAL_EVAL_LIMITS.perCaseJpy);
    expect(p.guaranteedMaxJpy).toBeLessThanOrEqual(REAL_EVAL_LIMITS.totalJpy);
    expect(p.expectedJpy).toBeGreaterThan(0);
    const many = planRun({ cases: Array.from({ length: 40 }, (_, i) => ({ ...SYN.cases[0], id: `M${i}` })), model: "claude-haiku-5-5", stabilityRepeats: 0 });
    expect(many.fitsOnePass).toBe(false); // 40件×15円=600円 > 500円
    expect(many.guaranteedMaxJpy).toBe(500);
    expect(planRun({ cases: SYN.cases, model: "unknown-model", stabilityRepeats: 0 }).problems.join()).toMatch(/料金が未登録/);
  });

  it("実行: 予算の枯渇で停止・実行回数・使用量を記録。AIの入力に正解は渡らない", async () => {
    const guard = new BudgetGuard(500, 15);
    let seenTask = "";
    const brain = new MockGroupingBrain("careful");
    const llm = { name: brain.name, step: async (m: Parameters<typeof brain.step>[0]) => { seenTask += JSON.stringify(m); return brain.step(m); } };
    const r = await runCases(SYN.cases, SYN.gold, 2, { makeLlm: () => llm as never, guard, followUps: 1, kind: "mock" });
    expect(r.stoppedBy).toBe("done");
    expect(r.records).toHaveLength(4); // AIを呼ぶ2件×2回
    expect(guard.runs).toBe(4);
    expect(seenTask).not.toMatch(/basis|official_announcement|"label"/); // 正解（根拠・ラベル）がAIの会話に現れない
    const tiny = new BudgetGuard(20, 15);
    tiny.record(10); // 残り10 < 15
    const stopped = await runCases(SYN.cases, SYN.gold, 1, { makeLlm: () => new MockGroupingBrain("careful"), guard: tiny, followUps: 0, kind: "mock" });
    expect(stopped.stoppedBy).toBe("budget");
    expect(stopped.records).toHaveLength(0);
  });

  it("実行: 連続して失敗したら止める（認証・通信障害で費用を浪費しない）。キーらしき文字列は記録しない", async () => {
    const down = { name: "down", async step() { throw new Error("401 invalid x-api-key sk-ant-SECRET123"); } };
    const r = await runCases(SYN.cases, SYN.gold, 1, { makeLlm: () => down as never, guard: new BudgetGuard(), followUps: 0, kind: "real", maxConsecutiveErrors: 2 });
    expect(r.stoppedBy).toBe("errors");
    expect(JSON.stringify(r.records)).not.toContain("SECRET123");
  });

  it("集計: 提案の正しさ（検証前）と検証後の結果を分ける。正解不明は別集計。同じ入力の再実行の安定性を出す", async () => {
    const recs = (await runCases(SYN.cases, SYN.gold, 2, { makeLlm: () => new MockGroupingBrain("eager"), guard: new BudgetGuard(), followUps: 0, kind: "mock" })).records;
    const s = summarizeRuns(SYN.cases, SYN.gold, recs);
    expect(s.unknownCases).toBe(1);
    expect(s.proposal.mustNotGroup).toBeGreaterThan(0);
    expect(s.proposal.wronglyGrouped).toBeGreaterThan(0); // 悪いAIの提案そのものは誤り
    expect(s.gated.autoHarm).toBe(0); // 検証を通った結果に、誤った自動は無い
    expect(s.stability.casesRepeated).toBeGreaterThan(0);
    expect(s.stability.rate).toBe(1);
    expect(s.kind).toBe("mock");
    const changed: RunRecord[] = recs.map((r, i) => (i === 0 ? { ...r, tier: "single" as const, memberIds: [] } : r));
    expect(summarizeRuns(SYN.cases, SYN.gold, changed).stability.unstableIds.length).toBeGreaterThan(0);
  });

  it("保存済みの提出の再判定（replay）は kind=replay で区別され、API・AIを使わない", async () => {
    const real = (await runCases(SYN.cases, SYN.gold, 1, { makeLlm: () => new MockGroupingBrain("careful"), guard: new BudgetGuard(), followUps: 0, kind: "real" })).records;
    const re = replayRecords(SYN.cases, SYN.gold, real);
    expect(re.every((r) => r.kind === "replay")).toBe(true);
    expect(re.map((r) => r.tier)).toEqual(real.map((r) => r.tier)); // 同じ検証層なら同じ結果
    expect(summarizeRuns(SYN.cases, SYN.gold, [...real, ...re]).kind).toBe("real+replay"); // 混ぜて集計すると種類が分かる（混ぜない運用の目印）
  });

  it("凍結ハッシュは改行コードに依存しない", () => {
    expect(datasetHashes("a\r\nb", "x").cases).toBe(datasetHashes("a\nb", "x").cases);
  });
});

describe.skipIf(!have)("実データセットの検査（eval/lottery-grouping-real/）", () => {
  it("入力と正解が整合し、正解に独立した根拠がある。凍結済みならハッシュが一致する", () => {
    const d = load();
    expect(validateDataset(d.cases, d.gold)).toEqual([]);
    if (existsSync(`${DIR}/frozen${SET}.json`)) {
      const f = JSON.parse(read("frozen.json")) as { cases: string; gold: string };
      const h = datasetHashes(d.casesText, d.goldText);
      expect(h.cases).toBe(f.cases);
      expect(h.gold).toBe(f.gold);
    }
  });
});

// ---------------------------------------------------------------- 実行前の確認・凍結・再判定・集計・実API（scripts/eval-grouping-real.mjs 経由）
const requireData = (): ReturnType<typeof load> => {
  if (!have) throw new Error(`評価データがありません（${DIR}/cases.json・gold.json）。npm run prod -- scripts/export-grouping-eval.mjs --yes-production --out=${DIR} で書き出してください`);
  const d = load();
  const errs = validateDataset(d.cases, d.gold);
  if (errs.length) throw new Error(`評価データに問題があります:\n${errs.join("\n")}`);
  return d;
};

describe.skipIf(env.REAL_GROUPING_PREFLIGHT !== "1")("実行前の確認（接続なし）", () => {
  it("データ・計画・費用・関門の状態を書き出す（キーは含まない）", () => {
    mkdirSync(OUT, { recursive: true });
    const repeats = Number(env.REAL_GROUPING_REPEATS) || 0;
    const gate = checkRealApi({ env, confirm: true, runsToday: 0 });
    let plan = null as ReturnType<typeof planRun> | null;
    let dataset: Record<string, unknown> = { ready: false };
    if (have) {
      const d = load();
      const errs = validateDataset(d.cases, d.gold);
      const frozen = existsSync(`${DIR}/frozen${SET}.json`) ? (JSON.parse(read("frozen.json")) as { cases: string; gold: string }) : null;
      const h = datasetHashes(d.casesText, d.goldText);
      const byCat: Record<string, number> = {};
      for (const c of d.cases) byCat[c.category] = (byCat[c.category] ?? 0) + 1;
      const byLabel: Record<string, number> = {};
      for (const g of Object.values(d.gold)) byLabel[g.label] = (byLabel[g.label] ?? 0) + 1;
      dataset = { ready: errs.length === 0, problems: errs, cases: d.cases.length, byCategory: byCat, byLabel, frozen: !!frozen, frozenMatches: !!frozen && frozen.cases === h.cases && frozen.gold === h.gold };
      plan = planRun({ cases: d.cases, model, stabilityRepeats: repeats });
    }
    const out = { gate: gate.ok ? { ok: true, model: gate.model } : { ok: false, reason: gate.reason }, dataset, plan, limits: REAL_EVAL_LIMITS, repeats };
    writeFileSync(`${OUT}/preflight.json`, JSON.stringify(out, null, 2));
    expect(JSON.stringify(out)).not.toMatch(/sk-ant|AGENT_ANTHROPIC_API_KEY=/);
  });
});

describe.skipIf(env.REAL_GROUPING_FREEZE !== "1")("評価データの凍結（正解の確定後・実行前）", () => {
  it("入力・正解のハッシュを frozen.json に保存する（以後の変更は実行時に検出される）", () => {
    const d = requireData();
    const h = datasetHashes(d.casesText, d.goldText);
    // ページの台帳（AIが fetch_source_page で参照する入力）も、組ごとにハッシュを固定する（実行時に照合）
    if (existsSync(`${DIR}/pages${SET}.json`)) {
      const hp = `${DIR}/pages-hashes.json`;
      const cur = existsSync(hp) ? (JSON.parse(readFileSync(hp, "utf8")) as Record<string, string>) : {};
      cur[SET_KEY] = datasetHashes(readFileSync(`${DIR}/pages${SET}.json`, "utf8"), "").cases;
      writeFileSync(hp, JSON.stringify(cur, null, 2) + "\n");
    }
    writeFileSync(`${DIR}/frozen${SET}.json`, JSON.stringify({ ...h, frozenOn: new Date().toISOString().slice(0, 10), cases: h.cases, gold: h.gold, count: d.cases.length }, null, 2) + "\n");
  });
});

describe.skipIf(env.REAL_GROUPING_EVAL !== "1")("実API評価（承認された費用・実行回数の範囲のみ）", () => {
  it("予算ガードの範囲で実行し、結果を保存する", async () => {
    const d = requireData();
    const f = existsSync(`${DIR}/frozen${SET}.json`) ? (JSON.parse(read("frozen.json")) as { cases: string; gold: string }) : null;
    const h = datasetHashes(d.casesText, d.goldText);
    if (!f || f.cases !== h.cases || f.gold !== h.gold) throw new Error("評価データが凍結されていない、または凍結後に変更されています（freeze をやり直す場合は、結果を新規の評価として扱う）");
    const approvedJpy = Number(env.REAL_GROUPING_APPROVED_MAX_JPY) || 0;
    const approvedRuns = Number(env.REAL_GROUPING_APPROVED_RUNS) || 0;
    if (!(approvedJpy > 0) || !(approvedRuns > 0)) throw new Error("承認された費用の上限と実行回数が必要です");
    if (approvedJpy > REAL_EVAL_LIMITS.totalJpy) throw new Error(`承認額が評価の上限（${REAL_EVAL_LIMITS.totalJpy}円）を超えています`);
    const repeats = Number(env.REAL_GROUPING_REPEATS) || 0;
    const plan = planRun({ cases: d.cases, model, stabilityRepeats: repeats, totalJpy: approvedJpy });
    if (plan.maxRuns > approvedRuns) throw new Error(`実行回数（${plan.maxRuns}）が承認された回数（${approvedRuns}）を超えます`);
    const gate = checkRealApi({ env, confirm: true, runsToday: 0 });
    if (!gate.ok) throw new Error(gate.reason);
    const strict = env.REAL_GROUPING_STRICT === "1";
    const client = new Anthropic({ apiKey: gate.apiKey });
    const makeLlm = () => new AnthropicAgentLLM(client, gate.model, { submit: { description: GROUPING_SUBMIT.description, schema: strict ? (GROUPING_SUBMIT_STRICT_SCHEMA as unknown as Record<string, unknown>) : GROUPING_SUBMIT.schema, emptyOutput: GROUPING_SUBMIT.emptyOutput, strict } });
    const guard = new BudgetGuard(approvedJpy, REAL_EVAL_LIMITS.perCaseJpy);
    const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    mkdirSync(OUT, { recursive: true });
    const ledger = ledgerOf();
    if (ledger && existsSync(`${DIR}/pages-hashes.json`)) {
      const want = (JSON.parse(readFileSync(`${DIR}/pages-hashes.json`, "utf8")) as Record<string, string>)[SET_KEY];
      if (want && want !== datasetHashes(readFileSync(`${DIR}/pages${SET}.json`, "utf8"), "").cases) throw new Error("ページの台帳が凍結後に変更されています");
      if (!want) throw new Error("ページの台帳が凍結されていません（freeze をやり直してください）");
    }
    const res = await runCases(d.cases, d.gold, 1 + repeats, { makeLlm, guard, fetcher: ledger, followUps: Number(env.REAL_GROUPING_FOLLOWUPS) || 1, kind: "real", maxConsecutiveErrors: strict ? 1 : 2, onRecord: (r) => console.log(`[grouping-real] ${r.caseId}#${r.pass} ${r.status} tier=${r.tier ?? "-"} cost=${(r.usage?.costJpy ?? 0).toFixed(2)}円 spent=${guard.spent.toFixed(2)}/${approvedJpy}円${r.error ? ` 問題: ${r.error}` : ""}`) });
    const summary = summarizeRuns(d.cases, d.gold, res.records, exclusionsOf());
    writeFileSync(`${OUT}/real-${runId}.json`, JSON.stringify({ runId, kind: "real", set: SET || "8f2", strict, ledger: !!ledger, model: gate.model, frozen: f, approvedJpy, approvedRuns, repeats, stoppedBy: res.stoppedBy, stopReason: res.stopReason, spentJpy: guard.spent, records: res.records, summary }, null, 2));
    expect(guard.spent).toBeLessThanOrEqual(approvedJpy);
  }, 1_800_000);
});

describe.skipIf(env.REAL_GROUPING_REPLAY !== "1")("保存済みの提出の再判定（API・AIなし。新規の精度評価ではない）", () => {
  it("最新の real-*.json の提出を、現在の検証層でやり直して replay-*.json に保存する", () => {
    const d = requireData();
    const files = existsSync(OUT) ? readdirSync(OUT).filter((x) => /^real-\d+\.json$/.test(x)).sort() : [];
    if (!files.length) throw new Error("保存済みの実行結果がありません");
    const saved = JSON.parse(readFileSync(`${OUT}/${files.at(-1)}`, "utf8")) as { records: RunRecord[]; runId: string };
    const re = replayRecords(d.cases, d.gold, saved.records);
    writeFileSync(`${OUT}/replay-${saved.runId}.json`, JSON.stringify({ kind: "replay", from: saved.runId, records: re, summary: summarizeRuns(d.cases, d.gold, re, exclusionsOf()) }, null, 2));
  });
});

// ---------------------------------------------------------------- 実データの組（8F-2 の17ケース・8F-3 の7ケース）× モックAI: 誤った自動グループ化が出ないこと（API・ネットワークなし）
describe("実データの組 × モックAI（全方針で、誤った自動グループ化が 0）", () => {
  const sets = [["", "8F-2"], ["-8f3", "8F-3"], ["-8f4", "8F-4"]] as const;
  for (const [suffix, name] of sets) {
    const ok = existsSync(`${DIR}/cases${suffix}.json`) && existsSync(`${DIR}/gold${suffix}.json`);
    it.skipIf(!ok)(`${name}: 入力に正解が混ざっていない・凍結済みで一致・全方針で誤った自動が0`, async () => {
      const casesText = readFileSync(`${DIR}/cases${suffix}.json`, "utf8");
      const goldText = readFileSync(`${DIR}/gold${suffix}.json`, "utf8");
      const cases = JSON.parse(casesText).cases as RealCase[];
      const gold = JSON.parse(goldText).labels as Record<string, RealGold>;
      expect(validateDataset(cases, gold)).toEqual([]);
      if (existsSync(`${DIR}/frozen${suffix}.json`)) {
        const f = JSON.parse(readFileSync(`${DIR}/frozen${suffix}.json`, "utf8")) as { cases: string; gold: string };
        const h = datasetHashes(casesText, goldText);
        expect(h).toEqual({ cases: f.cases, gold: f.gold });
      }
      // ページの台帳（AIの入力の一部）も凍結されている。台帳に正解（ラベル・説明）が混ざっていない
      if (existsSync(`${DIR}/pages${suffix}.json`)) {
        const pagesText = readFileSync(`${DIR}/pages${suffix}.json`, "utf8");
        const want = (JSON.parse(readFileSync(`${DIR}/pages-hashes.json`, "utf8")) as Record<string, string>)[suffix ? suffix.slice(1) : "8f2"];
        expect(datasetHashes(pagesText, "").cases).toBe(want);
        for (const g of Object.values(gold)) if (g.note) expect(pagesText).not.toContain(g.note.slice(0, 30));
      }
      // 正解の根拠（URL・ラベル）の文字列が、入力に現れない（正解の混入がない）。入力の情報源URLと、正解の根拠URLが一致するのは、同じ公式ページを指すためで許容（ラベル・説明文は不可）
      const inputText = JSON.stringify(cases);
      for (const g of Object.values(gold)) if (g.note) expect(inputText).not.toContain(g.note.slice(0, 30));
      for (const policy of ["careful", "eager", "liar", "lazy", "timid"] as const) {
        const recs = (await runCases(cases, gold, 1, { makeLlm: () => new MockGroupingBrain(policy), guard: new BudgetGuard(), followUps: 1, kind: "mock" })).records;
        const s = summarizeRuns(cases, gold, recs);
        expect(s.gated.autoHarm, `${name}/${policy}: 誤った自動 ${recs.filter((r) => r.score?.autoHarm).map((r) => r.caseId).join(",")}`).toBe(0);
      }
    });
  }
});

describe("評価ハーネス: 既存グループの系列は所属する抽選の系列と一致する（8F-3 の M05 の不具合の回帰テスト）", () => {
  const ok = existsSync(`${DIR}/cases-8f3.json`);
  it.skipIf(!ok)("8f3 の add_to_group ケースで、追加先が別の系列と判定されない", async () => {
    const cases = JSON.parse(readFileSync(`${DIR}/cases-8f3.json`, "utf8")).cases as RealCase[];
    const c = cases.find((x) => x.category === "add_to_group")!;
    const w = (await import("@/lib/agent/lottery-grouping/eval-world")).worldOf(c);
    expect(w.groups[0].chainId).toBe(w.subject.chainId);
    const gold = { [c.id]: { label: "auto", basis: [{ kind: "official_announcement", ref: "https://example.invalid", checkedAt: "2026-11-13" }] } } as Record<string, RealGold>;
    const recs = (await runCases([c], gold, 1, { makeLlm: () => new MockGroupingBrain("careful"), guard: new BudgetGuard(), followUps: 0, kind: "mock" })).records;
    expect(recs[0].downgrades?.join() ?? "").not.toContain("追加先が別の系列");
  });
});

// ---------------------------------------------------------------- ページの台帳の作成（実際の取得。無料。有料APIなし。REAL_GROUPING_CAPTURE=1）
describe.skipIf(env.REAL_GROUPING_CAPTURE !== "1")("ページの台帳の作成（登録された情報源URLの実際の取得。公開ページのみ・読み取りのみ）", () => {
  it("ケースの情報源URL（https・Xなど取得できないサイトを除く）を、既存の安全な取得で取得し、取得日時・ハッシュつきで pages<組>.json に保存する", async () => {
    const d = requireData();
    const { SafePageFetcher } = await import("@/lib/server/agent/real-providers");
    const { relevantExcerpt } = await import("@/lib/agent/lottery-grouping/identifiers");
    const { hash53 } = await import("@/lib/agent/lottery-grouping/verify");
    const f = new SafePageFetcher();
    const urls = [...new Set(d.cases.flatMap((c) => [c.subject, ...c.others].flatMap((l) => l.urls ?? [])))].filter((u) => /^https:\/\//.test(u) && !/(^|\.)(x\.com|twitter\.com|t\.co)$/i.test(new URL(u).hostname));
    const pages: LedgerPage[] = [];
    const failed: { url: string; message: string }[] = [];
    for (const url of urls) {
      const r = await f.fetchPage(url);
      if (!r.ok) {
        failed.push({ url, message: r.message });
        continue;
      }
      const text = relevantExcerpt(r.text);
      pages.push({ url, finalUrl: r.finalUrl, title: r.title.slice(0, 200), text, links: (r.links ?? []).map((l) => l.href).slice(0, 60), identifiers: r.identifiers ?? [], fetchedAt: new Date().toISOString(), hash: hash53(text) });
    }
    writeFileSync(`${DIR}/pages${SET}.json`, JSON.stringify({ version: 1, note: "実際に取得した公開ページの台帳（要点・最大4000文字。取得日時・ハッシュつき）。評価でAIが fetch_source_page で参照する。取得できなかったページは failed に記録", capturedAt: new Date().toISOString(), failed, pages }, null, 2) + "\n");
    expect(pages.length + failed.length).toBe(urls.length);
  }, 600_000);
});

// ---------------------------------------------------------------- 実際に取得したページの台帳での、情報源の調査（AIは台本どおり。ネットワーク・APIなし）
describe("実際に取得したページの台帳 × 調査（8f3 の M06 型: 同じイベントだが登録URLが別・情報源の文章なし）", () => {
  const ok = existsSync(`${DIR}/cases-8f3.json`) && existsSync(`${DIR}/pages-8f3.json`);
  it.skipIf(!ok)("取得したページから同じイベントIDを確認でき、強い裏づけ（event_id）になる。項目が一致しても、発表日が日付でない（11月中旬）ため自動ではなく候補", async () => {
    const cases = JSON.parse(readFileSync(`${DIR}/cases-8f3.json`, "utf8")).cases as RealCase[];
    const c = cases.find((x) => x.category === "insufficient")!;
    const ledger = new LedgerFetcher((JSON.parse(readFileSync(`${DIR}/pages-8f3.json`, "utf8")).pages as LedgerPage[]));
    const { worldOf } = await import("@/lib/agent/lottery-grouping/eval-world");
    const { evaluateGrouping } = await import("@/lib/agent/lottery-grouping/run");
    const w = worldOf(c);
    const peers = w.lotteries.filter((l) => l.sourceUrls[0] !== w.subject.sourceUrls[0]).map((l) => l.id);
    expect(peers.length).toBeGreaterThan(0);
    let n = 0;
    const usage = { inputTokens: 1, outputTokens: 1, costJpy: 0 };
    const llm = {
      name: "scripted",
      async step() {
        const i = n++;
        if (i === 0) return { kind: "tool_calls" as const, usage, calls: [w.subject.id, ...peers.slice(0, 1)].map((id, k) => ({ id: `f${k}`, name: "fetch_source_page", input: { lotteryId: id } })) };
        return { kind: "final" as const, usage, output: { action: "new_group", memberIds: peers.slice(0, 1), rationale: "同じイベントの店舗違い", claimedCommon: ["商品"] } };
      },
    };
    const o = await evaluateGrouping(w, { llm, allowAuto: true, fetcher: ledger, followUps: 0, formatRepairs: 0 });
    expect(o.usage?.fetches).toBe(2);
    expect(o.decision.strongSignals).toContain("event_id");
    expect(o.decision.tier).toBe("suggest");
    expect(o.decision.basis.join("\n")).toContain("同じイベントID");
  });
});
