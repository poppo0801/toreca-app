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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runVerification, type CaseSignals } from "@/lib/case-model/verification-runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import { investigateForCollection, realInvestigationDeps } from "@/lib/server/agent/case-bridge";
import { classifyItemsChange, isItemsChangeUnsafe, sanitizeItemsValue, type ItemsChange } from "@/lib/collector/product-text";
import { readdirSync } from "node:fs";
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

  it("指定した新規案件を3方式で処理し、全過程を保存する。案件単位の問題は隔離して続け、検証全体の停止条件に当たったときだけ止める", async () => {
    const plan = JSON.parse(readFileSync(`${OUT}/plan.json`, "utf8")) as { digest: string; cases: (PlanCase & { target: CaseTarget })[] };
    const picked = ids.map((id) => plan.cases.find((c) => c.caseId === id) ?? (() => { throw new Error(`計画にない事例: ${id}`); })());
    expect(picked.length).toBeGreaterThan(0);
    if (!(CAP > 0) || CAP > 100) throw new Error("承認された費用の上限（E9H3I_CAP_JPY。100円以下）が必要です");
    if (process.env.E9H3I_CONFIRM !== "yes") throw new Error("実行前の確認（E9H3I_CONFIRM=yes）が必要です");
    const env = { ...process.env, COLLECT_INVESTIGATE_CAP_JPY: String(CAP), COLLECT_INVESTIGATE_CONFIRM: "yes", COLLECT_INVESTIGATE_PER_CASE_JPY: String(PER_CASE), AGENT_MODEL: "claude-haiku-5-5" } as Record<string, string | undefined>;
    const real = realInvestigationDeps({ env, ledgerDir: OUT });
    if (!real.ok) throw new Error(real.reason);

    // 保存済みの調査結果の再利用（E9H3I_REUSE）。APIは呼ばない（費用0）。調査の結果は修正後の規則（商品名と詳細の分離）で整える
    const reuseIds = (process.env.E9H3I_REUSE ?? "").split(",").filter(Boolean);
    type Saved = { error: string | null; arms: unknown; stopJudgments?: { newRule: string; reason: string }[]; investigation: { result: CaseInvestigationResult; target: CaseTarget } | null };
    const savedAll = (id: string): Saved[] => {
      const out: Saved[] = [];
      for (const run of readdirSync(`${OUT}/runs`).sort()) {
        try {
          out.push(JSON.parse(readFileSync(`${OUT}/runs/${run}/case-${id}.json`, "utf8")) as Saved);
        } catch {
          /* この実行には無い */
        }
      }
      return out;
    };
    const loadSaved = (id: string): { r: CaseInvestigationResult; t: CaseTarget } => {
      const f = savedAll(id).filter((x) => x.investigation).pop();
      if (!f?.investigation) throw new Error(`再利用できる保存済みの調査結果が無い: ${id}`);
      return { r: f.investigation.result, t: f.investigation.target };
    };
    // 完了済み・隔離済み（結果が保存されている）の案件は、再実行しない。以前の実行で停止判定になった案件は、隔離として記録する（保存済みの判定の根拠から）
    const qFile = `${OUT}/quarantine.json`;
    const quarantine: Record<string, { reasons: string[]; at: string }> = existsSync(qFile) ? JSON.parse(readFileSync(qFile, "utf8")) : {};
    const done = new Set<string>();
    for (const c of picked) {
      const sv = savedAll(c.caseId).filter((x) => x.arms && !x.error);
      if (sv.length === 0 || reuseIds.includes(c.caseId)) continue;
      done.add(c.caseId);
      const stopped = sv[sv.length - 1].stopJudgments?.filter((x) => x.newRule === "stop") ?? [];
      if (stopped.length && !quarantine[c.caseId]) quarantine[c.caseId] = { reasons: stopped.map((x) => `商品構成の不一致: ${x.reason}`), at: new Date().toISOString() };
    }
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = `${OUT}/runs/${runId}`;
    mkdirSync(dir, { recursive: true });
    const summary: Record<string, unknown>[] = [];
    let retries = 0;

    const execute = async (caseId: string): Promise<CaseSignals> => {
      const c = picked.find((x) => x.caseId === caseId)!;
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
          reuseIds.includes(c.caseId)
            ? async () => {
                const sv = loadSaved(c.caseId);
                const fixed = { ...sv.r, fields: sv.r.fields.map((f) => (f.field === "items" && f.adopted ? { ...f, adopted: sanitizeItemsValue(f.adopted) } : f)) };
                captured = { r: fixed, t: sv.t };
                return { caseFile: resultToCaseFile(fixed, sv.t, new Date().toISOString()), stopReason: fixed.stopReason };
              }
            : (req) => investigateForCollection(req, { ...real.deps, onResult: (r, t) => { captured = { r, t }; } }),
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
      retries += cap1?.r.usage.retries ?? 0;

      // 停止の信号（案件単位と検証全体の分類は classifyStops が行う。修正前の規則の判定と、修正後の判定を、根拠つきでログに残す）
      const stopJudgments: { field: string; before: string; after: string; oldRule: "stop"; newRule: string; reason: string }[] = [];
      const itemsChanges: ItemsChange[] = [];
      const chainStoreChanges: string[] = [];
      for (const d of (result?.arms.C.judgment?.decisions ?? []).filter((x) => x.stage === "merge" && x.kind === "changed" && ["chain", "store", "items"].includes(String(x.field)))) {
        if (d.field !== "items") {
          chainStoreChanges.push(`${d.field} ${d.before}→${d.after}`);
          continue;
        }
        const ch = classifyItemsChange(String(d.before ?? "").split(" / ").filter(Boolean), String(d.after ?? "").split(" / ").filter(Boolean));
        itemsChanges.push(ch);
        stopJudgments.push({ field: "items", before: String(d.before ?? "").slice(0, 160), after: String(d.after ?? "").slice(0, 160), oldRule: "stop", newRule: isItemsChangeUnsafe(ch) ? "stop" : "continue", reason: `${ch.kind}: ${ch.reason}` });
      }
      const estC = (result?.arms.C.draft as { formJudgment?: { state?: string } } | null)?.formJudgment;
      const loops = cap1?.r.steps.filter((s) => !s.ok && /同じ|重複/.test(s.resultSummary)).length ?? 0;
      const unsupported = (cap1?.r.fields ?? []).filter((f) => f.state === "confirmed" && !f.sources.some((x) => x.url && !x.url.startsWith("(") && x.quote)).map((f) => f.field);
      // 複数案件にまたがるデータ混入: 結果の情報源URLに、この案件のものでない候補のIDがある
      const mine = new Set(c.members.map((m) => m.id));
      const foreign = new Set<string>();
      for (const a of ["A", "B", "C"] as const) for (const u of ((result?.arms[a].input as { sourceUrls?: string[] } | null)?.sourceUrls ?? [])) for (const m of u.matchAll(/(k-[0-9a-f]{8})/g)) if (!mine.has(m[1])) foreign.add(m[1]);
      const signals: CaseSignals = { error: error ?? null, itemsChanges, chainStoreChanges, injectionFlags: cap1?.r.injectionFlags ?? 0, unsupportedConfirmed: unsupported, loops, costJpy, investigationCalls: result?.investigationCalls ?? 0, estimateAutoRegistered: estC?.state === "estimated" && result?.arms.C.status === "auto_registered", foreignCaseIds: [...foreign], guardStopped: real.guard.stopped };
      // 全過程（元データ・AI調査結果・3方式の統合結果・停止判定の根拠）を、隔離する案件も含めて保存する
      writeFileSync(`${OUT}/runs/${runId}/case-${c.caseId}.json`, JSON.stringify({ caseId: c.caseId, patterns: c.patterns, planDigest: plan.digest, startedAt: new Date(t0).toISOString(), ms, costJpy, error: error ?? null, members: c.members, arms: result ? Object.fromEntries((["A", "B", "C"] as const).map((a) => [a, { ...result!.arms[a], draft: undefined, formJudgment: (result!.arms[a].draft as { formJudgment?: unknown } | null)?.formJudgment ?? null }])) : null, investigationCalls: result?.investigationCalls ?? 0, investigation: cap1 ? { result: cap1.r, target: cap1.t } : null, stopJudgments, worldLog: real.log.slice(logStart) as WorldLogEntry[] }, null, 1));
      summary.push({ caseId: c.caseId, patterns: c.patterns, costJpy, ms, cards: result ? { A: result.arms.A.openCards, B: result.arms.B.openCards, C: result.arms.C.openCards } : null, stopReason: cap1?.r.stopReason ?? null, steps: cap1?.r.usage.steps ?? 0, searches: cap1?.r.usage.searches ?? 0, fetches: cap1?.r.usage.fetches ?? 0, retries: cap1?.r.usage.retries ?? 0 });
      return signals;
    };

    const v = await runVerification({
      caseIds: picked.map((c) => c.caseId),
      done,
      limits: { perCaseCapJpy: PER_CASE, totalCapJpy: CAP, spentBeforeJpy: real.guard.spentJpy },
      execute,
      onOutcome: (o) => {
        if (o.status === "quarantined") quarantine[o.caseId] = { reasons: o.reasons, at: new Date().toISOString() };
      },
    });
    writeFileSync(qFile, JSON.stringify(quarantine, null, 1));
    writeFileSync(`${dir}/summary.json`, JSON.stringify({ runId, planDigest: plan.digest, model: "claude-haiku-5-5", capJpy: CAP, perCaseJpy: PER_CASE, spentJpy: Number(real.guard.spentJpy.toFixed(4)), retries, globalStop: v.globalStop, counts: { executed: v.executed, completed: v.completed, quarantined: v.quarantined, skippedDone: v.skippedDone, notRun: v.notRun }, outcomes: v.outcomes, cases: summary }, null, 1));
    console.log(`9H-3I 実行 ${runId}: 実行${v.executed}件（完了${v.completed}・隔離${v.quarantined}）・完了済みスキップ${v.skippedDone}・未実行${v.notRun}・累計 ${real.guard.spentJpy.toFixed(2)}円/${CAP}円${v.globalStop ? `・全体停止: ${v.globalStop}` : ""}`);
    expect(v.executed + v.skippedDone + v.notRun).toBe(picked.length);
    expect(real.guard.spentJpy).toBeLessThanOrEqual(CAP);
  }, 3_600_000);
});
