// @vitest-environment node
/**
 * Stage 9H-3O: 系列横断調査の実AI検証（**実API・実Webの検索と取得（費用が発生）**。承認された範囲だけ）。
 * 実行: node scripts/eval-9h3o.mjs run --cases=<id,id> --approved-max-jpy=<円> [--per-case-jpy=<円>]（E9H3O=1 のときだけ動く）
 *  - 対象は backups/eval-9h3o/plan.json（凍結済み）。結果を見て差し替えない
 *  - 各対象（系列の別店舗）について、起点の抽選の情報を「参考」として渡し、AIが検索語・調査先・終了を選んで、その店舗で同じ企画の抽選があるかを調べる
 *  - 登録・更新はしない（DBへ接続しない）。本番へは接続しない
 *  - 費用: backups/eval-9h3o/ledger.json に累計（検索料金を含む）。呼び出しの前に最大費用を確認し、累計・1件の上限を超える見込みなら呼ばない
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { investigateCase } from "@/lib/agent/case-investigator/engine";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import { realInvestigationDeps } from "@/lib/server/agent/case-bridge";

const ON = process.env.E9H3O === "1";
const OUT = "backups/eval-9h3o";
const CAP = Number(process.env.E9H3O_CAP_JPY ?? 0);
const PER_CASE = Number(process.env.E9H3O_PER_CASE_JPY ?? 9);
const ids = (process.env.E9H3O_CASES ?? "").split(",").filter(Boolean);

interface PlanCase {
  caseId: string;
  kind: "planned" | "control" | "region_probe";
  chain: string;
  store: string;
  product: string;
  seed: { store: string; url: string | null; applyStart: string | null; applyDeadline: string | null; knownStores: string[] };
  probability: number | null;
  reasons: string[];
}

describe.skipIf(!ON)("Stage 9H-3O 系列横断調査の実AI検証（承認制）", () => {
  it("凍結した対象を、AIが自律的に調べる。全過程を保存する", { timeout: 3_600_000 }, async () => {
    const plan = JSON.parse(readFileSync(`${OUT}/${process.env.E9H3O_PLAN_FILE ?? "plan.json"}`, "utf8")) as { digest: string; cases: PlanCase[] };
    const picked = ids.map((id) => plan.cases.find((c) => c.caseId === id) ?? (() => { throw new Error(`計画にない対象: ${id}`); })());
    expect(picked.length).toBeGreaterThan(0);
    if (!(CAP > 0) || CAP > 100) throw new Error("承認された費用の上限（E9H3O_CAP_JPY。100円以下）が必要です");
    if (process.env.E9H3O_CONFIRM !== "yes") throw new Error("実行前の確認（E9H3O_CONFIRM=yes）が必要です");
    const env = { ...process.env, COLLECT_INVESTIGATE_CAP_JPY: String(CAP), COLLECT_INVESTIGATE_CONFIRM: "yes", COLLECT_INVESTIGATE_PER_CASE_JPY: String(PER_CASE), AGENT_MODEL: "claude-haiku-5-5" } as Record<string, string | undefined>;
    const real = realInvestigationDeps({ env, ledgerDir: OUT });
    if (!real.ok) throw new Error(real.reason);
    const pool = JSON.parse(readFileSync("backups/eval-9h3f/pool-production-2026-11-17T14-51-51-832Z.json", "utf8")) as { officialHostsByChain?: Record<string, string[]> };
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync(`${OUT}/runs/${runId}`, { recursive: true });
    const summary: Record<string, unknown>[] = [];
    let stopped: string | null = null;

    for (const c of picked) {
      // 完了済みの対象は再実行しない（費用の重複を防ぐ）
      const dup = readdirSync(`${OUT}/runs`).some((r) => existsSync(`${OUT}/runs/${r}/case-${c.caseId}.json`));
      if (dup) {
        summary.push({ caseId: c.caseId, outcome: "skipped_done" });
        continue;
      }
      if (real.guard.spentJpy + PER_CASE > CAP) {
        stopped = `累計 ${real.guard.spentJpy.toFixed(2)}円＋1件の上限${PER_CASE}円が承認上限${CAP}円を超える見込みのため停止`;
        summary.push({ caseId: c.caseId, outcome: "not_run_cost" });
        continue;
      }
      const probe = c.kind === "region_probe";
      const when = c.seed.applyStart ? `${c.seed.applyStart}${c.seed.applyDeadline ? `〜${c.seed.applyDeadline}` : "〜"}` : "期間不明";
      const target: CaseTarget = { id: c.caseId, chain: c.chain, ...(c.store ? { store: c.store } : {}), storeMode: probe ? "select_on_apply" : "fixed", products: [c.product], known: {}, manualFields: [], knownSources: [] };
      const context = probe
        ? [
            `調べること: 系列「${c.chain}」が、対象地域（兵庫県・大阪府・京都府）の店舗で、企画「${c.product}」の抽選を行っているか。行っている店舗を、確認できた分だけ挙げる（店舗名・応募期間・応募方法とその根拠）。`,
            `見つからないときは、見つからないまま終える（「開催なし」と断定しない）。他の地域の店舗・別の商品・別の回の情報は混ぜない。`,
            `参考（確認の対象ではない）: 他の地域の「${c.seed.store}」で同じ企画の抽選が確認されている。`,
          ]
        : [
        `参考（確認の対象ではない）: 同じ系列の「${c.seed.store}」で、同じ企画「${c.product}」の抽選が確認されている（応募期間 ${when}）。`,
        `調べること: 「${c.store}」で、同じ企画・同じ時期の抽選が行われているか。見つからないときは、見つからないまま終える（「開催なし」と断定しない）。他の店舗・別の商品・別の回（発売時と再販など）の情報は混ぜない。`,
        ...(c.seed.url ? [`起点の告知（参考・転記元として扱わない）: ${c.seed.url}`] : []),
      ];
      const hosts = pool.officialHostsByChain?.[c.chain] ?? [];
      const classify = { officialHosts: hosts, officialAccounts: [] as string[], aggregatorHosts: [] as string[], aggregatorAccounts: [] as string[] };
      const logStart = real.log.length;
      const before = real.guard.spentJpy;
      const t0 = Date.now();
      let error: string | null = null;
      let result: Awaited<ReturnType<typeof investigateCase>> | null = null;
      try {
        real.deps.beforeCase?.(c.caseId);
        const controls = typeof real.deps.controls === "function" ? real.deps.controls(c.caseId) : real.deps.controls!;
        result = await investigateCase({ llm: real.deps.llm, world: real.deps.world, target, controls, classify, context });
      } catch (e) {
        error = (e as Error).message;
      }
      const cost = Number((real.guard.spentJpy - before).toFixed(4));
      writeFileSync(`${OUT}/runs/${runId}/case-${c.caseId}.json`, JSON.stringify({ caseId: c.caseId, kind: c.kind, planDigest: plan.digest, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, costJpy: cost, error, plan: c, context, result, worldLog: real.log.slice(logStart) }, null, 1));
      summary.push({ caseId: c.caseId, kind: c.kind, store: `${c.chain} ${c.store}`, costJpy: cost, error, stopReason: result?.stopReason ?? null, steps: result?.usage.steps ?? 0, searches: result?.usage.searches ?? 0, fetches: result?.usage.fetches ?? 0, retries: result?.usage.retries ?? 0, injection: result?.injectionFlags ?? 0 });
      if (error || (result?.injectionFlags ?? 0) > 0 || cost > PER_CASE * 1.5 || real.guard.stopped) {
        stopped = `異常のため停止: ${error ?? (result?.injectionFlags ? "本文に命令らしき文面" : real.guard.stopped ? "費用の関門が停止" : `1件の費用が上限を超過（${cost}円）`)}`;
        break;
      }
    }
    writeFileSync(`${OUT}/runs/${runId}/summary.json`, JSON.stringify({ runId, planDigest: plan.digest, model: "claude-haiku-5-5", capJpy: CAP, perCaseJpy: PER_CASE, spentJpy: Number(real.guard.spentJpy.toFixed(4)), stopped, cases: summary }, null, 1));
    console.log(`9H-3O 実行 ${runId}: 累計 ${real.guard.spentJpy.toFixed(2)}円/${CAP}円${stopped ? `・停止: ${stopped}` : ""}`);
    expect(real.guard.spentJpy).toBeLessThanOrEqual(CAP);
  });
});
