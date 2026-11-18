// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluatedFromAnswers, excludedReason, groupPool, type PoolCandidate } from "./new-cases";
import { buildHumanKnowledge } from "./human-knowledge";
import { lotteryKeyOf } from "./form-learning";

/**
 * Stage 9H-3I: 凍結した対象一覧（backups/eval-9h3k/plan.json。Git管理外）の整合性。対象一覧が無い環境ではスキップする。
 *  - 過去に人間が評価した抽選（同一・別バージョン・同じ情報元）が含まれない
 *  - 過去の正解情報（形態の実績）が、新規の対象に混入していない（同じ抽選のキーを持つ実績が無い）
 *  - 対象は互いに重複しない（同じ情報元URLを複数の対象が持たない）
 */
const PLAN = "backups/eval-9h3k/plan.json";
const DIR = "backups/review-answers";

// 評価データ（backups/。Git管理外）が無い環境（CI）では、テストが0件でファイルが失敗扱いにならないよう、スキップ表示を1件置く
it.skipIf(true)("評価データ（backups/）が無い環境ではこのファイルの検証をスキップ", () => {});
if (existsSync(PLAN) && existsSync(DIR)) describe("9H-3K 凍結した対象一覧の整合性", () => {
  const plan = JSON.parse(readFileSync(PLAN, "utf8")) as { cases: { caseId: string; members: PoolCandidate[] }[] };
  // 9H-3Iまでの全評価を対象に、評価済みが含まれないことを確認する
  const answers = readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.startsWith("review-answers-rs-9h3k-")).map((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")));
  const evaluated = evaluatedFromAnswers(answers);

  it("評価済みの抽選（同一・別バージョン・同じ情報元URL）を1件も含まない", () => {
    for (const c of plan.cases) for (const g of groupPool(c.members, { refine: false })) expect(excludedReason(g, evaluated), c.caseId).toBeNull();
  });
  it("過去の正解情報（形態の実績）を、新規の対象に混入させていない: 対象の抽選と同じキーの実績が無い", () => {
    const hk = buildHumanKnowledge(answers);
    const keys = new Set((hk.forms?.records ?? []).map((r) => r.key));
    for (const c of plan.cases) {
      for (const m of c.members) {
        const k = lotteryKeyOf({ caseId: m.id, aiOriginal: { extracted: { chain: m.input.chain, store: m.input.store || null, products: m.input.products, applyDeadline: m.input.applyDeadline } } }, m.input.chain);
        expect(keys.has(k), `${c.caseId}:${m.id}`).toBe(false);
      }
    }
  });
  it("対象どうしが重複しない: 同じ情報元URLを複数の対象が持たない", () => {
    const seen = new Map<string, string>();
    for (const c of plan.cases) {
      for (const m of c.members) {
        const u = (m.url ?? "").replace(/[?#].*$/, "");
        if (!u) continue;
        expect(seen.get(u) ?? c.caseId, u).toBe(c.caseId);
        seen.set(u, c.caseId);
      }
    }
  });
});

if (existsSync(PLAN) && existsSync("backups/eval-9h3i/plan.json") && existsSync("backups/eval-9h3f/plan.json")) describe("9H-3K 過去の対象一覧との重複", () => {
  it("9H-3F・9H-3Iの対象（候補ID・情報元URL）を1件も含まない", () => {
    const u = (x: string | null) => (x ?? "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
    const prev = new Set<string>();
    for (const d of ["eval-9h3f", "eval-9h3i"]) for (const c of JSON.parse(readFileSync(`backups/${d}/plan.json`, "utf8")).cases as { members: PoolCandidate[] }[]) for (const m of c.members) { prev.add(m.id); prev.add(u(m.url)); }
    const plan = JSON.parse(readFileSync(PLAN, "utf8")) as { cases: { caseId: string; members: PoolCandidate[] }[] };
    for (const c of plan.cases) for (const m of c.members) { expect(prev.has(m.id), m.id).toBe(false); expect(prev.has(u(m.url)), m.url ?? "").toBe(false); }
  });
});
