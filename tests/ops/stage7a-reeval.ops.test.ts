/**
 * Stage 7A: 既存の確認待ち候補を新しい判定基準で再評価する運用スクリプト（通常のテストでは実行されない）。
 *   STAGE7A_REEVAL=plan    ... 判定のみ（DBを一切変更しない）。新旧の基準の比較も出力する
 *   STAGE7A_REEVAL=execute ... 実行（候補の更新と、安全に登録できるものの新規登録。事前にバックアップを取得すること）
 *   STAGE7A_REPORT=<出力先.json> を指定すると、件ごとの結果を保存する
 *   例: STAGE7A_REEVAL=plan STAGE7A_REPORT=out.json npx vitest run tests/ops/stage7a-reeval.ops.test.ts
 * 再実行しても、登録済み・除外済みの候補は対象外（job_state=review の候補だけ）なので、二重登録・二重処理は起きない。
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { conditionsFromRow, type CollectDeps } from "@/lib/server/collector/run";
import { runReevaluation, type ReevalReport } from "@/lib/server/collector/reevaluate";
import { isReady } from "@/lib/collector/ready";
import { judge, type CandidateLite } from "@/lib/collector/reevaluate";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { adminClient } from "../helpers/db";

const mode = process.env.STAGE7A_REEVAL;

describe.skipIf(mode !== "plan" && mode !== "execute")("Stage 7A: 確認待ちの再評価（運用）", () => {
  it("再評価", async () => {
    const db = adminClient() as unknown as Db;
    const { data: hh } = await db.from("collection_settings").select("household_id").limit(2);
    expect(hh?.length).toBe(1);
    const householdId = hh![0].household_id as string;
    const now = new Date();
    const deps: CollectDeps = { db, householdId, trigger: "manual", now, actor: null, canRegister: false, serviceRegister: true, extractor: null, xClient: null };
    const report: Record<string, unknown> = { mode, at: now.toISOString() };

    // ---- 新旧の基準の比較（同一の候補群に、旧基準=注意付き登録なし と 新基準 を適用）
    const { data: settings } = await db.from("collection_settings").select("*").eq("household_id", householdId).maybeSingle();
    const cond = conditionsFromRow(settings as unknown as Record<string, unknown>);
    const data = await loadAppData(db, householdId);
    const { data: rows } = await db.from("collection_candidates").select("id,status,job_state,kind,source_url,dedupe_key,x_post_id,title,reasons,due_at,lottery_id,draft,triage,manual_state").eq("household_id", householdId).eq("job_state", "review").eq("status", "pending").limit(1000);
    const list = (rows ?? []) as unknown as (CandidateLite & { triage: string | null; manual_state: string | null })[];
    const judged = list.map((c) => ({ c, j: judge(c, data, cond, now, isReady) }));
    report.total = list.length;
    report.byTriageBefore = list.reduce<Record<string, number>>((m, c) => ((m[c.triage ?? "-"] = (m[c.triage ?? "-"] ?? 0) + 1), m), {});
    report.planByAction = judged.reduce<Record<string, number>>((m, x) => ((m[x.j ? x.j.action : "skip"] = (m[x.j ? x.j.action : "skip"] ?? 0) + 1), m), {});
    report.planRegisterGrades = judged.reduce<Record<string, number>>((m, x) => (x.j?.action === "register" ? ((m[x.j.decision?.grade ?? "-"] = (m[x.j.decision?.grade ?? "-"] ?? 0) + 1), m) : m), {});
    report.planRegionExcluded = judged.filter((x) => x.j?.action === "exclude" && !!x.j.exclusion).length;
    report.items = judged.map((x) => ({
      id: x.c.id,
      chain: (x.c.draft as { input?: { chain?: { name?: string } } } | null)?.input?.chain?.name ?? "",
      store: (x.c.draft as { input?: { store?: { name?: string } } } | null)?.input?.store?.name ?? "",
      action: x.j?.action ?? "skip",
      grade: x.j?.decision?.grade ?? "",
      cautions: x.j?.decision?.cautions.map((k) => k.code) ?? [],
      exclusion: x.j?.exclusion ? `${x.j.exclusion.prefecture}(${x.j.exclusion.note})` : "",
      reason: (x.j?.reasons[0] ?? "").slice(0, 100),
    }));

    if (mode === "execute") {
      const out = (await runReevaluation(deps, { execute: true, aiMax: 0 })) as ReevalReport;
      report.execute = { before: out.before, after: out.after, counts: out.counts, byClass: out.byClass };
    }
    if (process.env.STAGE7A_REPORT) writeFileSync(process.env.STAGE7A_REPORT, JSON.stringify(report, null, 1));
    console.log(JSON.stringify({ total: report.total, byTriageBefore: report.byTriageBefore, planByAction: report.planByAction, planRegisterGrades: report.planRegisterGrades, planRegionExcluded: report.planRegionExcluded, execute: report.execute ?? null }, null, 1));
  }, 300_000);
});
