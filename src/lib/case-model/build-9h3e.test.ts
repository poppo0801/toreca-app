// @vitest-environment node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resultToCaseFile } from "@/lib/agent/case-investigator/to-case";
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import { consolidateEvaluations, resolveEvalEntries, type BlindKeys, type ResultFileLike } from "./human-evals";
import type { IntegrationInput } from "./integrate";
import { buildReviewSet, caseFromEvalSummary, type ExtractedView, type LotteryMaterial } from "./review-builder";

/**
 * Stage 9H-3E: 人間評価の取り込み → 1抽選＝1評価の事例集の作成（保存済みの実データだけ。有料AIなし）。通常のテストでは実行されない（BUILD_9H3E=1 のときだけ。backups/ は Git管理外）。
 *   BUILD_9H3E=1 npx vitest run src/lib/case-model/build-9h3e.test.ts
 * 出力: backups/eval-9h3e/review-set-9h3e.json（評価ツール用）・review-key-9h3e.json（方式の対応表。評価が終わるまで開かない）・consolidated-evaluations.json（評価の統合結果）・report.json（件数）
 */
const ON = process.env.BUILD_9H3E === "1";
const ANS = "backups/review-answers";
const OUT = "backups/eval-9h3e";

interface RawResult extends ResultFileLike { results?: (NonNullable<ResultFileLike["results"]>[number] & { source?: { url?: string; title?: string }; aiOriginal?: { extracted?: ExtractedView & Record<string, unknown>; evidence?: { field: string; quote: string }[] } })[] }

function savedInvestigation(caseId: string): { result: CaseInvestigationResult; target: CaseTarget; startedAt: string } | null {
  const RUNS = "backups/eval-9h3d/runs";
  if (!existsSync(RUNS)) return null;
  let best: { result: CaseInvestigationResult; target: CaseTarget; startedAt: string } | null = null;
  for (const run of readdirSync(RUNS)) {
    const f = `${RUNS}/${run}/case-${caseId}.json`;
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8")) as { variant?: string; startedAt: string; B?: { judgment?: unknown }; investigation: { result: CaseInvestigationResult; target: CaseTarget } | null };
    if (j.investigation && j.B?.judgment && (j.variant ?? "B") === "B" && (!best || j.startedAt > best.startedAt)) best = { startedAt: j.startedAt, ...j.investigation };
  }
  return best;
}

describe.skipIf(!ON || !existsSync(ANS))("人間評価の取り込みと、1抽選＝1評価の事例集の作成（保存済みの実データ）", () => {
  it("評価JSONを全て読み込み、同じ抽選を統合し、統合した最終登録候補の事例集を作る", () => {
    const raw = readdirSync(ANS).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(`${ANS}/${f}`, "utf8")) as RawResult);
    // 方式を伏せた評価の対応表
    const keys: BlindKeys = {};
    for (const d of readdirSync("backups").filter((x) => x.startsWith("eval-"))) {
      for (const f of readdirSync(`backups/${d}`).filter((x) => /^review-key-.*\.json$/.test(x))) {
        const j = JSON.parse(readFileSync(`backups/${d}/${f}`, "utf8")) as { key?: Record<string, { caseId?: string; arm?: string }> };
        for (const [id, v] of Object.entries(j.key ?? {})) if (v.caseId) keys[id] = { caseId: v.caseId, arm: v.arm ?? "" };
      }
    }
    const entries = resolveEvalEntries(raw, keys);
    const unique = consolidateEvaluations(entries);
    // 評価結果の元データ（情報元URL・根拠の抜粋）を事例IDで引く
    const meta = new Map<string, { url: string; title: string; quotes: Record<string, string> }>();
    for (const f of raw) for (const r of f.results ?? []) {
      const id = keys[r.caseId ?? ""]?.caseId ?? (r.caseId ?? "").replace(/^b-/, "");
      if (r.source?.url && !meta.has(id)) meta.set(id, { url: r.source.url, title: r.source.title ?? "", quotes: Object.fromEntries((r.aiOriginal?.evidence ?? []).map((e) => [e.field, e.quote])) });
    }
    const KEY_BY_ARM = (arm: string): string | null => (arm === "9F-2の従来方式" || arm === "A" ? "従来方式の結果" : arm === "B" ? "AI方式の結果（9H-3D）" : arm === "B2" ? "AI方式の結果（情報源の分類の修正後）" : arm === "9H-2のB" ? "AI方式の結果（9H-2）" : null);
    const materials: LotteryMaterial[] = unique.map((l) => {
      const inputs: IntegrationInput[] = [];
      const seenInput = new Set<string>();
      const results = new Map<string, ExtractedView>();
      let base: { url: string; title: string } | null = null;
      for (const en of l.entries) {
        const m = meta.get(en.caseId);
        if (m && !base) base = { url: m.url, title: m.title };
      }
      const ents = entries.filter((e) => l.entries.some((x) => x.caseId === e.caseId && x.setId === e.setId && x.arm === e.arm));
      for (const e of ents) {
        const m = meta.get(e.caseId);
        const rk = KEY_BY_ARM(e.arm);
        if (rk && !results.has(rk)) {
          const x = e.extracted as Record<string, unknown>;
          results.set(rk, { chain: (x.chain as string) ?? null, store: (x.store as string) ?? null, products: (x.products as string[]) ?? [], applyStart: (x.applyStart as string) ?? null, applyDeadline: (x.applyDeadline as string) ?? null, resultDate: (x.resultDate as string) ?? null, conditions: (x.conditions as string) ?? null, lotteryForm: (x.lotteryForm as string) ?? null, receiveMethod: (x.receiveMethod as string) ?? null, applyMethod: (x.applyMethod as string) ?? null });
        }
        // 統合の入力にするのは、収集AIの読み取り（従来方式）。AI方式の結果は、統合の「結果」であり入力にしない（同じ情報を二重に数えない）
        if ((e.arm === "9F-2の従来方式" || e.arm === "A") && m && !seenInput.has(e.caseId)) {
          seenInput.add(e.caseId);
          inputs.push({ id: `a-${e.caseId}`, label: `従来方式の読み取り（${e.caseId}）`, caseFile: caseFromEvalSummary(`a-${e.caseId}`, e.extracted as never, m.url, m.quotes) });
        }
      }
      for (const cid of new Set(l.entries.map((x) => x.caseId))) {
        const inv = savedInvestigation(cid);
        if (inv) inputs.push({ id: `inv-${cid}`, label: `実AIの調査結果（${cid}）`, caseFile: resultToCaseFile(inv.result, inv.target, inv.startedAt), sameVerified: true });
      }
      if (inputs.length === 0) {
        const e = ents[0];
        const m = meta.get(e.caseId);
        inputs.push({ id: `e-${e.caseId}`, label: `評価の記録の読み取り（${e.caseId}）`, caseFile: caseFromEvalSummary(`e-${e.caseId}`, e.extracted as never, m?.url ?? "", m?.quotes ?? {}) });
      }
      // 基準（先頭）は、収集AIの読み取り（調査結果ではなく）にする
      inputs.sort((a, b) => Number(a.id.startsWith("inv-")) - Number(b.id.startsWith("inv-")) || a.id.localeCompare(b.id));
      return { lottery: l, source: base ?? { url: "", title: l.id }, inputs, results: [...results.entries()].map(([key, extracted]) => ({ key, extracted })) };
    });
    const build = buildReviewSet(materials, { setId: `rs-9h3e-${unique.length}-${entries.length}`, entriesTotal: entries.length });
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/review-set-9h3e.json`, JSON.stringify(build.set, null, 1));
    writeFileSync(`${OUT}/review-key-9h3e.json`, JSON.stringify({ note: "評価が終わるまで開かない", key: build.key }, null, 1));
    writeFileSync(`${OUT}/consolidated-evaluations.json`, JSON.stringify(unique, null, 1));
    writeFileSync(`${OUT}/report.json`, JSON.stringify({ ...build.report, sets: raw.map((f) => ({ setId: f.setId, results: (f.results ?? []).length })), conflictsInEvaluations: unique.filter((x) => x.conflicts.length > 0).map((x) => ({ id: x.id, fields: x.conflicts })) }, null, 1));
    expect(unique.length).toBeLessThan(entries.length);
    expect((build.set.cases as unknown[]).length).toBe(build.report.evaluable);
  });
});
