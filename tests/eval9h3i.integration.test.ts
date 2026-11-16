// @vitest-environment node
/**
 * Stage 9H-3I: 新規案件での3方式（A 従来／B AI調査＋従来の統合処理／C AI調査＋統合処理）の比較（**実API・実サイトへのアクセス（費用が発生）**。承認された範囲だけ）。
 * 実行: node scripts/eval-9h3i.mjs run --cases=<id,id> --approved-max-jpy=<円> [--per-case-jpy=<円>]（条件を確認して vitest を起動する。通常のテストでは実行されない: E9H3I=1 のときだけ）
 *  - 対象は backups/eval-9h3i/plan.json（凍結済み）。結果を見て差し替えない
 *  - 調査はC方式で1回だけ実AIで実行し、B方式は同じ調査結果を再生する（統合処理による差分だけを測る）。初期の読み取りは3方式で同一
 *  - 登録・更新はしない（自動登録オフ）。DBはローカルのテスト世帯のみ。本番へは接続しない
 *  - 費用: backups/eval-9h3i/ledger.json に累計（検索料金を含む）。呼び出しの前に最大費用を確認し、累計・1件の上限を超える見込みなら呼ばない
 *  - 中止: 費用上限・異常な繰り返し・調査が系列/店舗/商品を変更・統合に別の店舗の候補が入った疑い・根拠のない確定・本文に命令らしき文面
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import { investigateForCollection, realInvestigationDeps } from "@/lib/server/agent/case-bridge";
import { resultToCaseFile, withoutStructure } from "@/lib/agent/case-investigator/to-case";
import type { WorldLogEntry } from "@/lib/server/agent/case-world";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";
import { makeThreeway, type PlanCase } from "./helpers/threeway";

const ON = process.env.E9H3I === "1";
const OUT = "backups/eval-9h3i";
const CAP = Number(process.env.E9H3I_CAP_JPY ?? 0);
const PER_CASE = Number(process.env.E9H3I_PER_CASE_JPY ?? 12);
const ids = (process.env.E9H3I_CASES ?? "").split(",").filter(Boolean);

describe.skipIf(!ON || !dbTestsEnabled)("Stage 9H-3I 新規案件での3方式の比較（承認制）", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let tw: ReturnType<typeof makeThreeway>;
  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9h3ireal", 1);
    userIds.push(a.userId);
    const hid = (await a.db.rpc("bootstrap_household")).data as string;
    await a.db.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
    tw = makeThreeway({ sys, u1: a.db, hid });
  });
  afterAll(async () => {
    await tw?.clear();
    await cleanupTestUsers(admin, userIds);
  });

  it("指定した新規案件を3方式で処理し、全過程を保存する", async () => {
    const plan = JSON.parse(readFileSync(`${OUT}/plan.json`, "utf8")) as { digest: string; cases: (PlanCase & { target: CaseTarget })[] };
    const picked = ids.map((id) => plan.cases.find((c) => c.caseId === id) ?? (() => { throw new Error(`計画にない事例: ${id}`); })());
    expect(picked.length).toBeGreaterThan(0);
    if (!(CAP > 0) || CAP > 100) throw new Error("承認された費用の上限（E9H3I_CAP_JPY。100円以下）が必要です");
    if (process.env.E9H3I_CONFIRM !== "yes") throw new Error("実行前の確認（E9H3I_CONFIRM=yes）が必要です");
    const env = { ...process.env, COLLECT_INVESTIGATE_CAP_JPY: String(CAP), COLLECT_INVESTIGATE_CONFIRM: "yes", COLLECT_INVESTIGATE_PER_CASE_JPY: String(PER_CASE), AGENT_MODEL: "claude-haiku-5-5" } as Record<string, string | undefined>;
    const real = realInvestigationDeps({ env, ledgerDir: OUT });
    if (!real.ok) throw new Error(real.reason);

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = `${OUT}/runs/${runId}`;
    mkdirSync(dir, { recursive: true });
    const summary: Record<string, unknown>[] = [];
    let stopped: string | null = null;

    for (const c of picked) {
      if (stopped || real.guard.stopped) break;
      const logStart = real.log.length;
      let captured: { r: CaseInvestigationResult; t: CaseTarget } | null = null;
      const spentBefore = real.guard.spentJpy;
      const t0 = Date.now();
      let error: string | undefined;
      let result: Awaited<ReturnType<typeof tw.runCase3I>> | null = null;
      try {
        // B（9H-3F相当）は、Cの調査結果から構造解析で補った項目を除いて再生する。調査はCで1回だけ
        result = await tw.runCase3I(
          c,
          (req) => investigateForCollection(req, { ...real.deps, onResult: (r, t) => { captured = { r, t }; } }),
          () => {
            const cc = captured as { r: CaseInvestigationResult; t: CaseTarget } | null;
            if (!cc) return { skipped: "no_investigation_result" } as never;
            return { caseFile: resultToCaseFile(withoutStructure(cc.r), cc.t, new Date().toISOString()), stopReason: cc.r.stopReason };
          },
        );
      } catch (e) {
        error = (e as Error).message;
      }
      const ms = Date.now() - t0;
      const costJpy = Number((real.guard.spentJpy - spentBefore).toFixed(4));
      const cap1 = captured as { r: CaseInvestigationResult; t: CaseTarget } | null;
      writeFileSync(`${OUT}/runs/${runId}/case-${c.caseId}.json`, JSON.stringify({ caseId: c.caseId, patterns: c.patterns, planDigest: plan.digest, startedAt: new Date(t0).toISOString(), ms, costJpy, error: error ?? null, members: c.members, arms: result ? Object.fromEntries((["A", "B", "C"] as const).map((a) => [a, { ...result!.arms[a], draft: undefined, formJudgment: (result!.arms[a].draft as { formJudgment?: unknown } | null)?.formJudgment ?? null }])) : null, investigationCalls: result?.investigationCalls ?? 0, investigation: cap1 ? { result: cap1.r, target: cap1.t } : null, worldLog: real.log.slice(logStart) as WorldLogEntry[] }, null, 1));

      const bad: string[] = [];
      if (error) bad.push(`実行エラー: ${error.slice(0, 120)}`);
      const changed = (result?.arms.C.judgment?.decisions ?? []).filter((d) => d.stage === "merge" && d.kind === "changed" && ["chain", "store", "items"].includes(String(d.field)));
      if (changed.length) bad.push(`調査・統合が系列・店舗・商品を変更（誤統合の疑い）: ${changed.map((d) => `${d.field} ${d.before}→${d.after}`).join(" / ")}`);
      const estC = (result?.arms.C.draft as { formJudgment?: { state?: string } } | null)?.formJudgment;
      if (estC?.state === "estimated" && result?.arms.C.status === "auto_registered") bad.push("推定の店舗選択式が確認なしに自動登録された");
      if (cap1 && cap1.r.injectionFlags > 0) bad.push("本文に命令らしき文面を検出");
      const loops = cap1?.r.steps.filter((s) => !s.ok && /同じ|重複/.test(s.resultSummary)).length ?? 0;
      if (loops >= 3) bad.push(`同じ検索・取得の繰り返し（${loops}回）`);
      const unsupported = (cap1?.r.fields ?? []).filter((f) => f.state === "confirmed" && !f.sources.some((x) => x.url && !x.url.startsWith("(") && x.quote));
      if (unsupported.length) bad.push(`根拠のない確定: ${unsupported.map((f) => f.field).join("・")}`);
      if (costJpy >= PER_CASE) bad.push(`1件の費用が上限に到達（${costJpy}円）`);
      if (real.guard.spentJpy >= CAP) bad.push("累計の費用が上限に到達");
      if (result && result.investigationCalls > 1) bad.push(`調査が複数回実行された（${result.investigationCalls}回。BとCで同じ調査結果を使う前提が崩れる）`);
      if (bad.length) stopped = `${c.caseId}: ${bad.join("；")}`;
      summary.push({ caseId: c.caseId, patterns: c.patterns, costJpy, ms, cards: result ? { A: result.arms.A.openCards, B: result.arms.B.openCards, C: result.arms.C.openCards } : null, stopReason: cap1?.r.stopReason ?? null, steps: cap1?.r.usage.steps ?? 0, searches: cap1?.r.usage.searches ?? 0, fetches: cap1?.r.usage.fetches ?? 0, stop: bad.length ? bad : null });
    }
    writeFileSync(`${dir}/summary.json`, JSON.stringify({ runId, planDigest: plan.digest, model: "claude-haiku-5-5", capJpy: CAP, perCaseJpy: PER_CASE, spentJpy: Number(real.guard.spentJpy.toFixed(4)), stopped, cases: summary }, null, 1));
    console.log(`9H-3I 実行 ${runId}: ${summary.length}件・累計 ${real.guard.spentJpy.toFixed(2)}円/${CAP}円${stopped ? `・停止: ${stopped}` : ""}`);
    expect(summary.length).toBeGreaterThan(0);
    expect(real.guard.spentJpy).toBeLessThanOrEqual(CAP);
  }, 3_600_000);
});
