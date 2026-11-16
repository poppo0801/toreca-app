// @vitest-environment node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyCaseSource, type ClassifyContext } from "@/lib/agent/case-investigator/source-class";
import { evaluatedFromAnswers, PATTERN_LABEL, selectNewCases, type ChainTrendInfo, type PoolCandidate } from "./new-cases";
import { buildHumanKnowledge } from "./human-knowledge";
import { chainFormTendency, recordsFor } from "./form-learning";
import { chainCanonicalKey } from "@/lib/chain-normalize";

/**
 * Stage 9H-3F: 新規案件の確定（対象一覧の凍結）。通常のテストでは実行されない（BUILD_9H3F=1 のときだけ。backups/ は Git管理外）。
 *   1. 利用者が本番から候補プールを書き出す:  npm run prod -- scripts/export-new-candidates.mjs --yes-production
 *   2. オフラインで選定・凍結:               BUILD_9H3F=1 POOL_FILE=backups/eval-9h3f/pool-production-....json npx vitest run src/lib/case-model/build-9h3f.test.ts
 * 評価済みの抽選（backups/review-answers の全評価）を除き、同一抽選の重複を統合し、パターンの偏りを抑えて10〜15件を選ぶ。足りなければ水増しせず不足を報告する。
 * 出力: backups/eval-9h3f/plan.json（凍結。既にあれば作り直さない＝結果を見て差し替えない）・selection-report.json
 */
const ON = process.env.BUILD_9H3F === "1";
const OUT = process.env.PLAN_DIR ?? "backups/eval-9h3f";
const POOL = process.env.POOL_FILE ?? "";

interface PoolFile { exportedAt: string; target: string; officialHostsByChain?: Record<string, string[]>; candidates: PoolCandidate[] }

const LISTING = ["pokeso.jp", "torecabiyori.com", "cardchusen.com", "nyuka-now.com"];
/** 複数の店舗・抽選をまとめた投稿（地域別のまとめ）。基準の候補には、できるだけ使わない */
const roundup = (c: PoolCandidate) => (/地方 ||d+件/.test(c.title) ? 1 : 0);
const STAGE = process.env.STAGE_LABEL ?? "9H-3F";
const rank = (c: PoolCandidate) => (c.status === "auto_registered" ? 0 : c.status === "pending" ? 1 : c.status === "duplicate" ? 2 : 3);
const filled = (c: PoolCandidate) => [c.input.chain, c.input.store, c.input.applyStart, c.input.applyDeadline, c.input.resultDate, c.input.conditions].filter(Boolean).length;

describe.skipIf(!ON || !POOL || !existsSync(POOL))("新規案件の確定（候補プールから選定して凍結）", () => {
  it("評価済みの抽選を除き、重複を統合し、偏りを抑えて選定。対象一覧を凍結する", () => {
    if (existsSync(`${OUT}/plan.json`)) throw new Error("既に凍結済みです（plan.json）。結果を見て対象を差し替えないため、作り直しません");
    const pool = JSON.parse(readFileSync(POOL, "utf8")) as PoolFile;
    const answers = readdirSync("backups/review-answers").filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(`backups/review-answers/${f}`, "utf8")));
    const evaluated = evaluatedFromAnswers(answers);
    const today = new Date().toISOString().slice(0, 10);
    // 系列の傾向（人間の確認済みの実績）の有無と向き。値そのものは渡さない（選定のパターン分類にだけ使う）
    const hk = buildHumanKnowledge(answers as never);
    const chains = new Set((hk.forms?.records ?? []).filter((r) => r.status === "active").map((r) => chainCanonicalKey(r.chain)));
    const trend: ChainTrendInfo = { known: chains, selectLean: new Set([...chains].filter((k) => chainFormTendency(k, recordsFor(hk.forms?.records, k)).lean === "store_select")) };
    const { selected, report } = selectNewCases(pool.candidates, evaluated, { today, trend });
    const cases = selected.map((g) => {
      const anchor = [...g.members].sort((a, b) => rank(a) - rank(b) || roundup(a) - roundup(b) || filled(b) - filled(a) || a.id.localeCompare(b.id))[0];
      const i = anchor.input;
      const select = i.storeMode === "select_on_apply";
      const hosts = pool.officialHostsByChain?.[i.chain] ?? [];
      const classify: ClassifyContext = { officialHosts: hosts, officialAccounts: [], aggregatorHosts: LISTING, aggregatorAccounts: [] };
      const known: Record<string, string> = {};
      if (i.products.length) known.items = i.products.join(" / ");
      if (i.applyStart) known.applyStart = i.applyStart;
      if (i.applyDeadline) known.applyDeadline = i.applyDeadline;
      if (i.resultDate) known.resultDate = i.resultDate;
      return {
        caseId: g.id,
        group: g.patterns[0] ?? "normal",
        patterns: g.patterns,
        patternLabels: g.patterns.map((p) => PATTERN_LABEL[p]),
        why: `${g.patterns.map((p) => PATTERN_LABEL[p]).join("・")}（候補${g.members.length}件）`,
        known: false,
        members: g.members.map((m) => ({ id: m.id, status: m.status, url: m.url, title: m.title, reasons: m.reasons, input: m.input, evidence: m.evidence, viaList: m.viaList, failKind: m.failKind })),
        anchorId: anchor.id,
        target: { id: g.id, chain: i.chain, ...(select || !i.store ? {} : { store: i.store }), storeMode: select ? "select_on_apply" : "fixed", products: i.products, known, manualFields: [], knownSources: anchor.url ? [{ url: anchor.url, kind: classifyCaseSource(anchor.url, classify).kind }] : [] },
        classify,
        baseline: {
          decision: { status: anchor.status },
          extracted: { chain: i.chain || null, store: select ? null : i.store || null, products: i.products, applyStart: i.applyStart, applyDeadline: i.applyDeadline, resultDate: i.resultDate ? (i.resultEnd ? `${i.resultDate}` : i.resultDate) : null, conditions: i.conditions || null, lotteryForm: select ? "store_select" : null, receiveMethod: i.receiveMethod === "unknown" ? null : i.receiveMethod, applyMethod: i.applyMethod === "unknown" ? null : i.applyMethod },
          sourceUrl: anchor.url,
          sourceTitle: anchor.title,
        },
      };
    });
    const digest = createHash("sha256").update(JSON.stringify(cases.map((c) => c.caseId))).digest("hex").slice(0, 16);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/selection-report.json`, JSON.stringify({ ...report, poolFile: POOL, poolExportedAt: pool.exportedAt, poolTarget: pool.target, evaluatedEntries: evaluated.length }, null, 1));
    writeFileSync(`${OUT}/plan.json`, JSON.stringify({ frozenAt: new Date().toISOString(), stage: STAGE, digest, poolFile: POOL, budget: { model: "claude-haiku-5-5", search: "anthropic web_search（既存）" }, report, cases }, null, 1));
    expect(cases.length).toBeGreaterThan(0);
  }, 300_000);
});
