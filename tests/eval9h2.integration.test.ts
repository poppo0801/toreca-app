// @vitest-environment node
/**
 * Stage 9H-2: 実AI・実際のWeb情報源による自律調査（B方式）の検証。**実API・実サイトへのアクセス（費用が発生）**。承認された範囲だけ。
 * 実行: npm run eval:9h2 -- run --cases=<id,id> --approved-max-jpy=<円>（scripts/eval-9h2.mjs が条件を確認する）。通常のテストでは実行されない（E9H2=1 のときだけ）。
 *  - 実AI: Claude Haiku 5.5（開発専用キー・real-gate の関門）。検索: Anthropic の web_search（同じキー・追加契約なし）。取得: 既存の安全な取得（robots.txt 尊重・SSRF対策・間隔1.5秒）
 *  - 費用: 台帳 backups/eval-9h2/ledger.json に累計を記録（検索料金を含む）。呼び出しの前に最大費用を確認し、累計の上限・1件15円を超える見込みなら呼ばない
 *  - DBには一切接続・書き込みしない。結果は backups/eval-9h2/runs/<実行ID>/ にローカル保存（Git管理外）
 *  - AIには正解（過去の人間評価）を渡さない。初期情報はA方式（従来）の抽出結果と同じ
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnthropicWebSearch } from "@/lib/agent/anthropic";
import { resolveControls } from "@/lib/agent/collection-planner/controls";
import { GuardStop, RealRunGuard, type LedgerState } from "@/lib/agent/collection-planner/real-guard";
import { investigateCase, type CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import { createInvestigatorBrain } from "@/lib/agent/case-investigator/real-brain";
import { summarizeUsefulness } from "@/lib/agent/case-investigator/source-memory";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import type { ClassifyContext } from "@/lib/agent/case-investigator/source-class";
import { checkRealApi } from "@/lib/agent/real-gate";
import { createCaseWorld, type WorldLogEntry } from "@/lib/server/agent/case-world";

const ON = process.env.E9H2 === "1";
const OUT = "backups/eval-9h2";
const LEDGER = `${OUT}/ledger.json`;
const CAP = Number(process.env.E9H2_CAP_JPY ?? 0);
const PER_CASE = Number(process.env.E9H2_PER_CASE_JPY ?? 15);
const ids = (process.env.E9H2_CASES ?? "").split(",").filter(Boolean);

interface CaseDef {
  caseId: string;
  group: string;
  why: string;
  target: CaseTarget;
  classify: ClassifyContext;
  baseline: unknown;
}

describe.skipIf(!ON)("Stage 9H-2 実AI×実Web情報源の自律調査（承認制）", () => {
  it("指定した事例をB方式（自律調査）で実行し、行動ログ・費用・結果を保存する", async () => {
    const all = (JSON.parse(readFileSync(`${OUT}/cases.json`, "utf8")) as { cases: CaseDef[] }).cases;
    const picked = ids.map((id) => all.find((c) => c.caseId === id) ?? (() => { throw new Error(`未定義の事例: ${id}`); })());
    expect(picked.length).toBeGreaterThan(0);
    if (!(CAP > 0) || CAP > 100) throw new Error("承認された費用の上限（E9H2_CAP_JPY。100円以下）が必要です");
    const g = checkRealApi({ env: process.env, confirm: process.env.E9H2_CONFIRM === "yes", runsToday: 0 });
    if (!g.ok) throw new Error(g.reason);
    if (g.model !== "claude-haiku-5-5") throw new Error(`今回の承認はHaiku 5.5のみです（設定: ${g.model}）`);

    const prior = (() => {
      try {
        return JSON.parse(readFileSync(LEDGER, "utf8")) as LedgerState;
      } catch {
        return null;
      }
    })();
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = `${OUT}/runs/${runId}`;
    mkdirSync(dir, { recursive: true });
    const guard = new RealRunGuard({
      capJpy: CAP,
      perCaseJpy: PER_CASE,
      model: g.model,
      spentBefore: prior?.spentJpy ?? 0,
      persist: (s) => writeFileSync(LEDGER, JSON.stringify({ ...s, entries: [...(prior?.entries ?? []), ...s.entries] }, null, 1)),
    });
    const spentAtStart = guard.spentJpy;
    const summary: { caseId: string; group: string; status: string; stopReason: string; costJpy: number; ms: number; steps: number; searches: number; fetches: number; error?: string }[] = [];

    for (const c of picked) {
      if (guard.stopped) break;
      guard.startCase(c.caseId);
      const raw = new Anthropic({ apiKey: g.apiKey, maxRetries: 0, timeout: 60_000 });
      const brain = createInvestigatorBrain(guard.wrapClient(raw, "agent"), g.model);
      const { world, log } = createCaseWorld({ search: new AnthropicWebSearch(raw, g.model), guard });
      const d = resolveControls({ runsToday: 0, costTodayJpy: 0, workerDailyAiLimit: 30, aiCallsToday: 0 }, { mode: "dry_run", realApi: true });
      if (!d.ok) throw new Error(d.reason);
      const remaining = Math.max(0, CAP - guard.spentJpy);
      const controls = { ...d.controls, limits: { ...d.controls.limits, maxSteps: 16, maxMs: 150_000, maxCostJpy: Math.min(PER_CASE, remaining) } };
      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      let result: CaseInvestigationResult | null = null;
      let error: string | undefined;
      try {
        result = await investigateCase({ llm: brain, world, target: c.target, controls, classify: c.classify });
      } catch (e) {
        error = (e as Error).message;
        if (e instanceof GuardStop) guard.stop(e.message);
      }
      const ms = Date.now() - t0;
      const costJpy = guard.caseSpentJpy;
      writeFileSync(`${dir}/case-${c.caseId}.json`, JSON.stringify({ caseId: c.caseId, group: c.group, why: c.why, model: g.model, startedAt, endedAt: new Date().toISOString(), ms, costJpy, error: error ?? null, result, worldLog: log satisfies WorldLogEntry[], usefulness: result ? summarizeUsefulness(result) : [], baseline: c.baseline }, null, 1));
      summary.push({ caseId: c.caseId, group: c.group, status: result?.status ?? "failed", stopReason: result?.stopReason ?? "error", costJpy: Number(costJpy.toFixed(3)), ms, steps: result?.usage.steps ?? 0, searches: result?.usage.searches ?? 0, fetches: result?.usage.fetches ?? 0, ...(error ? { error } : {}) });
      // 停止条件: 費用の関門・APIエラーの連続。ここでは、上限・安全上の問題（GuardStop）で全体を止める
      if (error && !(error.includes("費用") || error.includes("上限"))) guard.stop(`想定外のエラー（${c.caseId}）: ${error.slice(0, 120)}`);
    }
    writeFileSync(`${dir}/summary.json`, JSON.stringify({ runId, model: g.model, capJpy: CAP, spentBeforeJpy: spentAtStart, spentAfterJpy: guard.spentJpy, thisRunJpy: Number((guard.spentJpy - spentAtStart).toFixed(3)), stopped: guard.stopped, cases: summary }, null, 1));
    console.log(`9H-2 実行 ${runId}: ${summary.length}件・今回の費用 ${(guard.spentJpy - spentAtStart).toFixed(2)}円・累計 ${guard.spentJpy.toFixed(2)}円/${CAP}円${guard.stopped ? `・停止: ${guard.stopped}` : ""}`);
    expect(summary.length).toBeGreaterThan(0);
    expect(guard.spentJpy).toBeLessThanOrEqual(CAP);
  }, 1_800_000);
});
