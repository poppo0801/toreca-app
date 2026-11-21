// @vitest-environment node
/**
 * Stage 10K: シャドーワーカーの**実AI**での通し検証（ローカルDB・有料・承認済みの範囲だけ。通常の `npm run test:db` では実行されない）。
 *   node scripts/shadow-worker-10k.mjs run --confirm=yes
 * 内容: 未知データ（10J の20件。登録値は一覧のときだけ、一覧の最初の項目から派生）をキューに入れ、ワーカーで処理する。公開リンクがある告知は、リンク先の公開ページを取得して
 * 追加の原文（linkedPages）として保存し、**新しい漏洩検出**（認証・秘密の実値と入力された私的な値だけを止める）で通るかを実測する。
 * 費用: ワーカーの日次予算（8円）・月次予算（20円）・1件3円・取得は最大60回。**台帳（shadow_judgments）の合計と、モデルの使用量記録の合計が一致すること**を確認する。
 * 緊急停止: 実行の途中でDBの enabled を false にして、AI呼び出しが止まること・再開で続きが処理されることを確認する。
 * 出力: eval/real-data/shadow-worker-10l.json（Git管理外・件数・統計のみ）。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractPageText } from "@/lib/ai/page-text";
import { redact } from "@/lib/case-model/redact";
import { AnthropicJudgmentModel } from "@/lib/judgment/anthropic-model";
import { detectLeaks, detectLeaksStrict } from "@/lib/judgment/eval/phase2";
import { precheckFetchTarget } from "@/lib/judgment/fetch-safety";
import { splitListPost } from "@/lib/judgment/list-split";
import { checkJudgmentRealRun } from "@/lib/judgment/real-gate";
import type { Db } from "@/lib/server/lottery-service";
import { fetchRespectingRobots } from "@/lib/server/safe-fetch";
import { runShadowWorker } from "@/lib/server/shadow/worker";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const env = process.env;
const isX = (h: string): boolean => /(^|[.])(t[.]co|x[.]com|twitter[.]com)$/.test(h.toLowerCase());
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;

describe.skipIf(!dbTestsEnabled || env.JUDGMENT_10L_HOLD !== "1")("Stage 10L: 独立ホールドアウト（12件）のシャドーワーカー実AI検証（有料）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let hid: string;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s10lh", 1);
    userIds.push(a.userId);
    hid = (await a.db.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await admin.from("shadow_judgments").delete().eq("household_id", hid);
    await admin.from("shadow_jobs").delete().eq("household_id", hid);
    await admin.from("collection_candidates").delete().like("dedupe_key", "https://shadow10l-hold.example.invalid/%");
    await cleanupTestUsers(admin, userIds);
  });

  it("20件を実AIで処理し、台帳・予算・緊急停止・新しい漏洩検出を検証する", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const model = new AnthropicJudgmentModel(new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 }), { model: gate.model });

    const rows = new Map((JSON.parse(readFileSync(latest("backups/refresh-10g", "evidence-"), "utf8")) as { rows: { id: string; text: string; via: string; url: string; fetchedAt: string; links?: string[]; imageCount?: number; imageStatus?: string }[] }).rows.map((r) => [r.id, r]));
    const set = (JSON.parse(readFileSync("eval/real-data/holdout-10l-set.json", "utf8")) as { items: { id: string; cat: string }[] }).items;
    const gold = (JSON.parse(readFileSync("eval/real-data/gold-10l.json", "utf8")) as { labels: Record<string, { type: string; opp?: number | null; items?: number; focusOpp?: number; structure?: string | null }> }).labels;

    await admin.from("shadow_settings").upsert({ household_id: hid, enabled: true, enqueue_enabled: true, daily_budget_jpy: 8, monthly_budget_jpy: 20, per_case_cap_jpy: 3, max_jobs_per_run: 5, retention_days: 30 });
    const linkLog: { fetched: number; failed: number; strictBlocked: number; newBlocked: number; stored: number } = { fetched: 0, failed: 0, strictBlocked: 0, newBlocked: 0, stored: 0 };
    let fetches = 0;
    const idx = new Map<string, string>(); // candidate id → H番号
    for (const [i, it] of set.entries()) {
      const r = rows.get(it.id);
      if (!r) continue;
      const text = redact(r.text);
      const split = splitListPost(text);
      // 登録値: 一覧のときだけ、最初の項目から派生（対象案件の焦点を試す）。一覧でなければ登録値なし
      const g0 = split.groups[0];
      const label = g0?.label.replace(/[《》]/g, "").replace(/（.*$/, "").replace(/\s*-\s*[0-9]+件.*$/, "").trim();
      const prod = g0?.items[0]?.replace(/https?:\/\/\S+/g, "").replace(/\s*-\s*[0-9/()月火水木金土日:〆]+.*$/, "").replace(/^・/, "").trim();
      const draft = split.isList ? { input: { chain: { name: "" }, store: { name: label ?? "" }, items: [{ product: { name: prod ?? "" } }], storeMode: "fixed" } } : {};
      // 公開リンク（展開済み・https・X/短縮URL以外）は、既存の取得部品で取得して linkedPages に保存（最大2件）
      const linkedPages: { url: string; text: string; fetchedAt: string }[] = [];
      for (const u of [...new Set(r.links ?? [])].filter((x) => { const p = precheckFetchTarget(x); return p.ok && p.url.protocol === "https:" && !isX(p.url.hostname); }).slice(0, 2)) {
        if (fetches >= 60) break;
        fetches++;
        const f = await fetchRespectingRobots(u, { timeoutMs: 10_000, maxBytes: 1_000_000, accept: ["text/html", "application/xhtml+xml"] });
        if (!f.ok) { linkLog.failed++; continue; }
        linkLog.fetched++;
        const p = extractPageText(f.body, f.finalUrl, 6_000, 20);
        const t = redact(`${p.title}\n${p.text}`).slice(0, 3000);
        if (detectLeaksStrict(t).length) linkLog.strictBlocked++;
        if (detectLeaks(t).length) linkLog.newBlocked++;
        linkedPages.push({ url: u, text: t, fetchedAt: new Date().toISOString() });
      }
      linkLog.stored += linkedPages.length ? 1 : 0;
      const evidence = { v: 1, url: r.url ?? "https://x.example.invalid/1", fetchedAt: r.fetchedAt ?? new Date().toISOString(), via: r.via, origin: "unknown", text, truncated: false, links: (r.links ?? []).slice(0, 5), imageCount: r.imageCount ?? 0, imageStatus: r.imageStatus ?? "none", hash: createHash("sha256").update(text).digest("hex").slice(0, 32), sent: 0, ...(linkedPages.length ? { linkedPages } : {}) };
      const key = `https://shadow10l-hold.example.invalid/${i + 1}`;
      const ins = await admin.from("collection_candidates").insert({ household_id: hid, dedupe_key: key, source_url: key, title: `K${i + 1}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence } as never, draft: draft as never }).select("id").single();
      expect(ins.error).toBeNull();
      idx.set(ins.data!.id as string, `K${i + 1}`);
      const q = await admin.rpc("shadow_enqueue", { p_household: hid, p_candidate: ins.data!.id, p_hash: evidence.hash });
      expect(q.data).toBe(true);
    }

    const run = () => runShadowWorker({ db: admin as unknown as Db, model, env: { SHADOW_WORKER: "on" }, workerId: "real-w", limit: 4, timeBudgetMs: 100_000 });
    const runs: unknown[] = [];
    let killChecked = false;
    for (let k = 0; k < 14; k++) {
      const r = await run();
      runs.push({ k, ...r });
      if (r.stoppedBy === "no_jobs") break;
      if (k === 0 && !killChecked) {
        // 緊急停止: DBのフラグを切ると、続きは確保されず（AIも呼ばれず）、再開すると処理が続く
        await admin.from("shadow_settings").update({ enabled: false }).eq("household_id", hid);
        const callsBefore = model.usageLog.length;
        const stopped = await run();
        expect(stopped.stoppedBy).toBe("no_jobs");
        expect(model.usageLog.length).toBe(callsBefore);
        await admin.from("shadow_settings").update({ enabled: true }).eq("household_id", hid);
        killChecked = true;
      }
      // 予算保留（budget）で戻ったジョブは翌日扱い。実測のため、待たずに終了する
      if ((r.byReason as Record<string, number>).budget) break;
    }

    const judg = (await admin.from("shadow_judgments").select("*").eq("household_id", hid)).data!;
    const jobs = (await admin.from("shadow_jobs").select("candidate_id,status,skip_reason,last_error,attempts").eq("household_id", hid)).data!;
    const ledger = judg.reduce((a, x) => a + Number(x.cost_jpy ?? 0), 0);
    const usage = model.usageLog.reduce((a, u) => a + (u.costJpy ?? 0), 0);
    const by = <T,>(xs: T[], f: (x: T) => string): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});

    // 暫定ラベル（gold-10l。AI作成・人の確認なし）との比較（件数のみ）
    const cmp = { lotteryComparable: 0, lotteryOppMatch: 0, notLottery: 0, notLotteryOk: 0, listFocus: 0, listFocusOk: 0, structureDeterminate: 0, structureMatch: 0, structureUnknown: 0, structureWrong: 0 };
    const review: unknown[] = [];
    for (const j of judg) {
      const h = idx.get(j.candidate_id as string);
      const lab = h ? gold[h] : undefined;
      if (!h || !lab) continue;
      const rec = j.record as { next?: { structure?: string; opportunityCount?: number; unresolvedCount?: number } };
      const text = (await admin.from("collection_candidates").select("last_good").eq("id", j.candidate_id).single()).data!.last_good as { evidence?: { text?: string } };
      review.push({ id: h, label: lab, status: j.status, structure: j.structure_new, opportunities: j.opportunity_count, unresolved: rec.next?.unresolvedCount ?? null, text: text.evidence?.text ?? "" });
      if (lab.type === "list") { cmp.listFocus++; if (j.opportunity_count === lab.focusOpp) cmp.listFocusOk++; }
      else if (lab.type === "not_lottery") { cmp.notLottery++; if (j.opportunity_count === 0) cmp.notLotteryOk++; }
      else {
        cmp.lotteryComparable++;
        if (j.opportunity_count === lab.opp) cmp.lotteryOppMatch++;
        if (lab.structure) { cmp.structureDeterminate++; if (j.structure_new === lab.structure) cmp.structureMatch++; else if (j.structure_new === "unknown") cmp.structureUnknown++; else cmp.structureWrong++; }
      }
    }
    writeFileSync("eval/real-data/human-review-10l-items.json", JSON.stringify({ note: "人の確認用（ローカルのみ・Git管理外）。伏せ字後の保存原文と、新AIの判断の要約", items: review }, null, 1));
    const out = {
      candidates: idx.size,
      jobsByStatus: by(jobs, (j) => j.status),
      skipReasons: by(jobs.filter((j) => j.status === "skipped"), (j) => String(j.skip_reason)),
      judgmentsByStatus: by(judg, (j) => j.status),
      structures: by(judg, (j) => String(j.structure_new)),
      ledgerJpy: Math.round(ledger * 10000) / 10000,
      modelUsageJpy: Math.round(usage * 10000) / 10000,
      calls: model.usageLog.length,
      avgLatencyMs: Math.round(judg.reduce((a, x) => a + (x.latency_ms ?? 0), 0) / Math.max(1, judg.length)),
      fetches,
      linkedPages: linkLog,
      vsProvisionalLabels: cmp,
      skipped: jobs.filter((j) => j.status === "skipped").length,
      runs,
    };
    writeFileSync("eval/real-data/shadow-worker-10l.json", JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ ...out, runs: undefined }));
    expect(Math.abs(ledger - usage)).toBeLessThan(0.05); // 台帳とモデルの使用量記録が一致（再試行を含む）
    expect(ledger).toBeLessThanOrEqual(8 + 1e-6); // 日次の予算を超えない
    expect(killChecked).toBe(true);
  }, 3_000_000);
});
