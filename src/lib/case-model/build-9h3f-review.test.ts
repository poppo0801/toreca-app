// @vitest-environment node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildThreewaySet, casesFromRunFiles, scoreThreeway, type AnswerResult, type RunCaseFile } from "./threeway-review";

/**
 * Stage 9H-3F: 実行結果 → 人間評価用の事例集（1抽選＝1評価・方式名を伏せ順序ランダム）／評価結果の自動採点。通常のテストでは実行されない。
 *   事例集の作成:  BUILD_9H3F_REVIEW=1 npx vitest run src/lib/case-model/build-9h3f-review.test.ts
 *   採点:          BUILD_9H3F_REVIEW=1 SCORE_ANSWERS=backups/review-answers/<評価結果>.json npx vitest run src/lib/case-model/build-9h3f-review.test.ts
 * 出力: backups/eval-9h3f/review-set-9h3f.json・review-key-9h3f.json（評価が終わるまで開かない）・score-9h3f.json（採点）
 */
const ON = process.env.BUILD_9H3F_REVIEW === "1";
const OUT = "backups/eval-9h3f";

describe.skipIf(!ON || !existsSync(`${OUT}/plan.json`))("3方式の評価セットの作成・採点（実データ）", () => {
  it("実行結果から事例集を作る。評価結果があれば、3方式を採点する", () => {
    const plan = JSON.parse(readFileSync(`${OUT}/plan.json`, "utf8")) as { digest: string; cases: { caseId: string; baseline: { sourceUrl: string | null; sourceTitle: string } }[] };
    // 事例ごとに、エラーのない最新の実行結果を使う
    const latest = new Map<string, RunCaseFile & { startedAt: string }>();
    for (const run of readdirSync(`${OUT}/runs`).sort()) {
      for (const f of readdirSync(`${OUT}/runs/${run}`).filter((x) => x.startsWith("case-"))) {
        const j = JSON.parse(readFileSync(`${OUT}/runs/${run}/${f}`, "utf8")) as RunCaseFile & { startedAt: string };
        if (j.arms && !j.error) latest.set(j.caseId, j);
      }
    }
    const cases = casesFromRunFiles([...latest.values()], (id) => {
      const c = plan.cases.find((x) => x.caseId === id);
      return { url: c?.baseline.sourceUrl ?? "", title: c?.baseline.sourceTitle ?? id };
    });
    const build = buildThreewaySet(cases, { setId: `rs-9h3f-${plan.digest}` });
    writeFileSync(`${OUT}/review-set-9h3f.json`, JSON.stringify(build.set, null, 1));
    writeFileSync(`${OUT}/review-key-9h3f.json`, JSON.stringify({ note: "評価が終わるまで開かない", key: build.key }, null, 1));
    if (process.env.SCORE_ANSWERS) {
      const ans = JSON.parse(readFileSync(process.env.SCORE_ANSWERS, "utf8")) as { results: AnswerResult[] };
      const score = scoreThreeway(ans.results, build, cases);
      writeFileSync(`${OUT}/score-9h3f.json`, JSON.stringify({ answers: process.env.SCORE_ANSWERS, ...score, cases: cases.map((c) => ({ caseId: c.caseId, cards: c.cards })) }, null, 1));
    }
    expect((build.set.cases as unknown[]).length).toBe(cases.length);
  });
});
