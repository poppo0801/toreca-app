// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluatedFromAnswers, excludedReason, groupPool, type PoolCandidate } from "./new-cases";
import { buildHumanKnowledge } from "./human-knowledge";
import { lotteryKeyOf } from "./form-learning";

/**
 * Stage 9H-3I: 凍結した対象一覧（backups/eval-9h3i/plan.json。Git管理外）の整合性。対象一覧が無い環境ではスキップする。
 *  - 過去に人間が評価した抽選（同一・別バージョン・同じ情報元）が含まれない
 *  - 過去の正解情報（形態の実績）が、新規の対象に混入していない（同じ抽選のキーを持つ実績が無い）
 *  - 対象は互いに重複しない（同じ情報元URLを複数の対象が持たない）
 */
const PLAN = "backups/eval-9h3i/plan.json";
const DIR = "backups/review-answers";

// 評価データ（backups/。Git管理外）が無い環境（CI）では、テストが0件でファイルが失敗扱いにならないよう、スキップ表示を1件置く
it.skipIf(true)("評価データ（backups/）が無い環境ではこのファイルの検証をスキップ", () => {});
if (existsSync(PLAN) && existsSync(DIR)) describe("9H-3I 凍結した対象一覧の整合性", () => {
  const plan = JSON.parse(readFileSync(PLAN, "utf8")) as { cases: { caseId: string; members: PoolCandidate[] }[] };
  // この対象一覧の評価結果（9H-3I）自体は除く。対象一覧を作った時点の評価済み（それ以前）との整合を確認する
  const answers = readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.includes("9h3i")).map((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")));
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
