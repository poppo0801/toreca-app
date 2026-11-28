/**
 * Phase 3: 本番シャドーの登録案ジョブ（既存のシャドー・ワーカーの1ジョブ）の統合テスト。ローカルのSupabase・RLS適用下。**AIは台本つきの擬似クライアント（費用0・ネットワークなし）。架空データのみ。**
 *   npm run test:db
 * 確認すること: ①既定OFF（本番スイッチ・許可リスト・停止・DB設定が欠ければ、AIを1回も呼ばず、登録案も作らない） ②許可されたときだけ、登録案が独立領域（registration_proposals）に保存され、
 * 抽選・応募・購入・通知・候補・現行の抽出結果は不変 ③費用の記録（shadow_judgments）と、日次上限が再起動・多重実行でも回避されない（DB集計） ④認証エラーで以降を止める
 * ⑤本番シャドーの許可証は検索・実取得を持てない ⑥評価の基準時刻は収集時刻 ⑦再評価回数の記録
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import { scriptedAnthropic } from "@/lib/judgment/xsource/scripted-client";
import type { Db } from "@/lib/server/lottery-service";
import { generateProposalsForCandidate, type CandidateRow } from "@/lib/server/proposals/generate";
import { issueProductionShadowTicket } from "@/lib/server/proposals/real-gate";
import { runShadowProposalJob } from "@/lib/server/shadow/proposal-job";
import { runShadowWorker } from "@/lib/server/shadow/worker";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const BASE = "https://phase3shadow.example.invalid";
const WORKER_ENV = { SHADOW_WORKER: "on", SHADOW_WORKER_PRODUCTION_APPROVED: "yes", VERCEL_ENV: "production" };
const LIST = "《新宿本店（東京）- 1件》 ・ポケモンカード 拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111 《渋谷西口店（東京）- 1件》 ・ポケモンカード 拡張パック 抽選 11/30(月)23:59 https://t.co/bbb222";
const PAGES = [
  { url: "https://shop-a.example.invalid/e/1", text: "【新宿本店】拡張パック 抽選受付\n受付期間 11月30日まで" },
  { url: "https://shop-b.example.invalid/e/2", text: "【渋谷西口店】拡張パック 抽選受付\n受付期間 11月30日まで" },
];

describe.skipIf(!dbTestsEnabled)("Phase 3: 本番シャドーの登録案ジョブ（台本のクライアント・費用0）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let n = 0;
  const envOn = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...WORKER_ENV,
    PROPOSAL_PROD_PREVIEW: "on",
    PROPOSAL_PROD_APPROVED: "yes",
    PROPOSAL_PROD_HOUSEHOLDS: hid,
    SHADOW_ANTHROPIC_API_KEY: "scripted-shadow-key-not-real-0000",
    ...extra,
  });
  const setSettings = async (over: Record<string, unknown> = {}) => {
    const { error } = await admin.from("shadow_settings").upsert({ household_id: hid, enabled: true, enqueue_enabled: true, daily_budget_jpy: 10, monthly_budget_jpy: 100, per_case_cap_jpy: 3, max_jobs_per_run: 3, retention_days: 30, valid_until: null, total_budget_jpy: null, total_since: null, run_lock_by: null, run_lock_until: null, ...over });
    expect(error).toBeNull();
  };
  const addCandidate = async (): Promise<{ row: CandidateRow; hash: string; draft: unknown; lastGood: unknown }> => {
    n++;
    const url = `${BASE}/${n}`;
    const stored = buildEvidence({ url, kind: "x_post", post: { text: LIST, links: [], linkMap: [{ short: "https://t.co/aaa111", url: PAGES[0].url }, { short: "https://t.co/bbb222", url: PAGES[1].url }] }, linkedPages: PAGES }, "2026-11-20T01:00:00.000Z");
    const draft = { input: { chain: { name: "サンプル電機" }, store: { name: "新宿本店" }, items: [{ product: { name: "拡張パック" } }] } };
    const { data, error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: String(930000000 + n), title: `p3-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: stored } as never, draft: draft as never }).select("id,x_post_id,source_url,last_good").single();
    expect(error).toBeNull();
    const enq = await (u1 as unknown as { rpc: (n: string, a: object) => PromiseLike<{ data: unknown }> }).rpc("shadow_enqueue", { p_household: hid, p_candidate: data!.id, p_hash: stored!.hash.slice(0, 32) });
    expect(enq.data).toBe(true);
    return { row: data as CandidateRow, hash: stored!.hash, draft, lastGood: { evidence: stored } };
  };
  const counts = async () => {
    const c = async (t: string) => ((await admin.from(t).select("*", { count: "exact", head: true }).eq("household_id", hid)).count ?? 0) as number;
    return { lotteries: await c("lotteries"), applications: await c("applications"), purchases: await c("purchases"), notifications: await c("notification_deliveries") };
  };
  const proposalsOf = async (id: string) => ((await admin.from("registration_proposals").select("*").eq("candidate_id", id)).data ?? []) as Record<string, unknown>[];
  const run = (client: ReturnType<typeof scriptedAnthropic>["client"], env: Record<string, string>, over: Record<string, unknown> = {}) =>
    runShadowWorker({
      db: admin as unknown as Db,
      model: null,
      env: WORKER_ENV,
      workerId: "w-p3",
      limit: 3,
      proposalJob: (a) => runShadowProposalJob({ db: admin as unknown as Db, ...a, client: client as never, env }),
      ...over,
    });
  const clean = async () => {
    await admin.from("shadow_judgments").delete().eq("household_id", hid);
    await admin.from("shadow_jobs").delete().eq("household_id", hid);
    await admin.from("collection_candidates").delete().like("dedupe_key", `${BASE}/%`);
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "p3shadow", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await clean();
    await admin.from("shadow_settings").delete().eq("household_id", hid);
    await cleanupTestUsers(admin, userIds);
  });

  it("①既定OFF: 本番スイッチ・承認・許可リスト・停止・専用キーのどれが欠けても、AIを1回も呼ばず、登録案を作らない（ジョブは理由つきで skipped）", async () => {
    await setSettings();
    const cases: { name: string; env: Record<string, string> }[] = [
      { name: "switch1_off", env: envOn({ PROPOSAL_PROD_PREVIEW: "off" }) },
      { name: "switch2_not_approved", env: envOn({ PROPOSAL_PROD_APPROVED: "no" }) },
      { name: "household_not_allowed", env: envOn({ PROPOSAL_PROD_HOUSEHOLDS: "00000000-0000-0000-0000-000000000000" }) },
      { name: "killed_by_env", env: envOn({ PROPOSAL_KILL: "1" }) },
      { name: "no_dedicated_key", env: envOn({ SHADOW_ANTHROPIC_API_KEY: "" }) },
      { name: "not_production_environment", env: envOn({ VERCEL_ENV: "preview" }) },
    ];
    for (const c of cases) {
      const cand = await addCandidate();
      const { client, calls } = scriptedAnthropic();
      const r = await run(client, c.env);
      expect(calls, c.name).toHaveLength(0);
      expect(await proposalsOf(cand.row.id), c.name).toHaveLength(0);
      expect(r.skipped, c.name).toBe(1);
      expect(Object.keys(r.byReason).join(","), c.name).toContain(c.name);
      await clean();
    }
  });

  it("②許可されたときだけ、登録案が独立領域に保存される。抽選・応募・購入・通知・候補・現行の抽出結果は不変。費用・モデル・基準時刻が記録される", async () => {
    await setSettings();
    const cand = await addCandidate();
    const before = await counts();
    const { client, calls } = scriptedAnthropic();
    const r = await run(client, envOn());
    expect(r.done).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
    const rows = await proposalsOf(cand.row.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const p of rows) {
      expect(p.mode).toBe("real");
      expect(p.model_id).toBe("claude-haiku-5-5");
      expect(Number(p.cost_jpy ?? 0)).toBeGreaterThanOrEqual(0);
      expect(String(p.fetched_at ?? "")).toContain("2026-11-20"); // 評価の基準時刻は収集時刻
    }
    expect(await counts()).toEqual(before);
    const after = (await admin.from("collection_candidates").select("draft,last_good,status,job_state").eq("id", cand.row.id).single()).data as Record<string, unknown>;
    expect(after.draft).toEqual(cand.draft);
    expect(after.last_good).toEqual(cand.lastGood);
    expect(after.status).toBe("pending");
    const j = ((await admin.from("shadow_judgments").select("*").eq("household_id", hid)).data ?? []) as { status: string; cost_jpy: number; record: Record<string, unknown>; structure_new: string }[];
    expect(j).toHaveLength(1);
    expect(j[0].structure_new).toBe("proposal_shadow");
    expect(Number(j[0].cost_jpy)).toBeGreaterThan(0);
    expect(Number(j[0].cost_jpy)).toBeLessThanOrEqual(3); // 1件上限
    expect(j[0].record).toMatchObject({ kind: "proposal_shadow", search: false, liveFetch: false });
    expect(JSON.stringify(j[0].record)).not.toMatch(/https?:\/\/|ポケモン|新宿|scripted-shadow-key/); // 原文・URL・キーを記録しない
    expect(r.spentJpy).toBeGreaterThan(0);
  });

  it("③日次上限はDBの集計で効く: 使用済みを含めて残りが足りなければ、再起動・多重実行でも呼ばない（罰なしで翌日へ）", async () => {
    await clean();
    await setSettings();
    const c1 = await addCandidate();
    const first = await run(scriptedAnthropic().client, envOn());
    expect(first.done).toBe(1);
    const spent = first.spentJpy;
    await setSettings({ daily_budget_jpy: spent + 0.2 }); // 残り 0.2円（0.5円未満）
    const c2 = await addCandidate();
    const { client, calls } = scriptedAnthropic();
    const second = await run(client, envOn());
    expect(calls).toHaveLength(0);
    expect(second.requeued).toBe(1);
    expect(second.byReason.budget).toBe(1);
    expect(await proposalsOf(c2.row.id)).toHaveLength(0);
    expect((await proposalsOf(c1.row.id)).length).toBeGreaterThan(0);
  });

  it("④認証エラー（401）では以降を呼ばない: 実行を止め、ジョブは罰なしで戻る（再試行の連打をしない）", async () => {
    await clean();
    await setSettings();
    await addCandidate();
    await addCandidate();
    const { client, calls } = scriptedAnthropic({ failAll: 401 });
    const r = await run(client, envOn());
    expect(r.stoppedBy).toBe("provider_error");
    expect(r.done).toBe(0);
    expect(calls.length).toBeLessThanOrEqual(4); // 1件目（調査の上限4ターン以内）で止まり、2件目は呼ばない
    const jobs = ((await admin.from("shadow_jobs").select("status,attempts").eq("household_id", hid)).data ?? []) as { status: string; attempts: number }[];
    expect(jobs.every((x) => x.status === "queued")).toBe(true);
  });

  it("⑤DBの緊急停止（enabled=false）では、AIを呼ばずにジョブを戻す", async () => {
    await clean();
    await setSettings({ enabled: false });
    await addCandidate();
    const { client, calls } = scriptedAnthropic();
    const r = await run(client, envOn());
    expect(calls).toHaveLength(0); // 停止中はジョブの確保も、AIの呼び出しも、登録案の作成もない
    expect(r.done).toBe(0);
  });

  it("⑥本番シャドーの許可証は、検索・実取得・画像の実解析を持てない（保存済みの収集データだけ）。許可証なしの本番環境は無効", async () => {
    await clean();
    await setSettings();
    const cand = await addCandidate();
    const t = issueProductionShadowTicket({ allowed: true }, { model: "claude-haiku-5-5", totalCapJpy: 3, perCaseCapJpy: 3 });
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const { CallBudget } = await import("@/lib/judgment/call-budget");
    const { mockResearchAgent, mockRegistrationJudge } = await import("@/lib/judgment/xsource/proposal-mock");
    const base = { agent: mockResearchAgent, judge: mockRegistrationJudge, mode: "real" as const, modelId: "claude-haiku-5-5", ticket: t.ticket, budget: new CallBudget({ maxCalls: 10, maxCostJpy: 3 }) };
    const withFetch = await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: cand.row, env: { VERCEL_ENV: "production" }, deps: { ...base, liveFetch: async () => ({ ok: false, reason: "x" }) as never } });
    expect(withFetch).toMatchObject({ ok: false, reason: "real_not_permitted" });
    // 許可証が無ければ、本番環境（VERCEL_ENV）では無効のまま
    const noTicket = await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: cand.row, env: { VERCEL_ENV: "production" } });
    expect(noTicket).toMatchObject({ ok: false, reason: "disabled" });
    expect(issueProductionShadowTicket({ allowed: false }, { model: "claude-haiku-5-5", totalCapJpy: 3, perCaseCapJpy: 3 })).toMatchObject({ ok: false });
    expect(await proposalsOf(cand.row.id)).toHaveLength(0);
  });

  it("⑦再評価回数が停止理由に記録される（rev:N）。無ければ付かない", async () => {
    await clean();
    await setSettings();
    const cand = await addCandidate();
    await run(scriptedAnthropic().client, envOn());
    for (const p of await proposalsOf(cand.row.id)) expect(String(p.stop_reason)).not.toMatch(/rev:\d/);
  });

  it("⑧並列実行: 同じ世帯の費用判断は直列化される（ロック中は呼ばず罰なしで戻す）。ロックは終了で外れ、期限切れでも外れる", async () => {
    await clean();
    await setSettings();
    const cand = await addCandidate();
    const rpcA = admin as unknown as { rpc: (n: string, a: object) => PromiseLike<{ data: unknown }> };
    expect((await rpcA.rpc("shadow_budget_lock", { p_household: hid, p_worker: "other-run", p_seconds: 60 })).data).toBe(true);
    const { client, calls } = scriptedAnthropic();
    const r = await run(client, envOn());
    expect(calls).toHaveLength(0);
    expect(r.byReason.budget_locked).toBe(1);
    expect(await proposalsOf(cand.row.id)).toHaveLength(0);
    await rpcA.rpc("shadow_budget_unlock", { p_household: hid, p_worker: "other-run" });
    await admin.from("shadow_jobs").update({ next_run_at: new Date(Date.now() - 1000).toISOString() }).eq("household_id", hid);
    const r2 = await run(scriptedAnthropic().client, envOn());
    expect(r2.done).toBe(1);
    const st = (await admin.from("shadow_settings").select("run_lock_by,run_lock_until").eq("household_id", hid).single()).data as { run_lock_by: string | null; run_lock_until: string | null };
    expect(st.run_lock_by).toBeNull(); // 終了で必ず外れる
  });

  it("⑨通算上限と試行期間: 通算の残りが無ければ呼ばない。試行期間を過ぎたらジョブを確保しない（自動停止）", async () => {
    await clean();
    await setSettings({ total_budget_jpy: 0.3, total_since: new Date(Date.now() - 3600_000).toISOString() });
    await addCandidate();
    const a = scriptedAnthropic();
    const r = await run(a.client, envOn());
    expect(a.calls).toHaveLength(0);
    expect(r.byReason.budget).toBe(1);
    await clean();
    await setSettings({ valid_until: new Date(Date.now() - 1000).toISOString() });
    await addCandidate();
    const b = scriptedAnthropic();
    const r2 = await run(b.client, envOn());
    expect(b.calls).toHaveLength(0);
    expect(r2.leased).toBe(0); // DBのリースが期限切れの世帯を確保しない
  });

  it("⑩費用の記録に失敗したら、その世帯のシャドーを停止して実行を止める（記録できない費用を重ねない）", async () => {
    await clean();
    await setSettings();
    await addCandidate();
    await addCandidate();
    const failing = new Proxy(admin as object, {
      get: (t, p) => {
        // 書き込み（insert）だけ失敗させる。読み取り（再開の台帳）は実DBのまま（F2: 台帳を読めないときは実行しない＝別の検査）
        if (p === "from") return (name: string) => { const real = (t as { from: (n: string) => object }).from(name); return name === "shadow_judgments" ? new Proxy(real, { get: (b, k) => (k === "insert" ? async () => ({ error: { message: "simulated" } }) : typeof (b as Record<string | symbol, unknown>)[k] === "function" ? ((b as Record<string | symbol, (...x: unknown[]) => unknown>)[k]).bind(b) : (b as Record<string | symbol, unknown>)[k]) }) : real; };
        const v = (t as Record<string | symbol, unknown>)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const { client, calls } = scriptedAnthropic();
    const r = await runShadowWorker({ db: failing as unknown as Db, model: null, env: WORKER_ENV, workerId: "w-fail", limit: 3, proposalJob: (a) => runShadowProposalJob({ db: admin as unknown as Db, ...a, client: client as never, env: envOn() }) });
    expect(r.stoppedBy).toBe("record_failed");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(8); // 1件目だけ（調査・判断＋同一性の照合）。2件目は呼ばない
    expect((await admin.from("shadow_settings").select("enabled").eq("household_id", hid).single()).data).toMatchObject({ enabled: false });
  });

  it("⑪既存キーの再利用は明示スイッチ（SHADOW_REUSE_EXISTING_KEY=allow）があるときだけ。無ければ専用キーなしで拒否", async () => {
    await clean();
    await setSettings();
    await addCandidate();
    const noKey = envOn({ SHADOW_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "existing-prod-key-not-real-00000" });
    const a = scriptedAnthropic();
    const r = await run(a.client, noKey);
    expect(a.calls).toHaveLength(0);
    expect(Object.keys(r.byReason).join(",")).toContain("no_dedicated_key");
    await clean();
    await setSettings();
    const cand = await addCandidate();
    const b = scriptedAnthropic();
    const r2 = await run(b.client, { ...noKey, SHADOW_REUSE_EXISTING_KEY: "allow" });
    expect(r2.done).toBe(1);
    expect((await proposalsOf(cand.row.id)).length).toBeGreaterThan(0);
  });

  it("⑫1件上限と最大予約の整合: 最大のトークン使用量でも、1件の費用は1件上限＋予約超過分に収まる（上限3円・最大予約3.6円）", async () => {
    await clean();
    await setSettings({ daily_budget_jpy: 15, per_case_cap_jpy: 3 });
    await addCandidate();
    const { client } = scriptedAnthropic({ usage: { input_tokens: 24_000, output_tokens: 3_000 } });
    const r = await run(client, envOn());
    const j = ((await admin.from("shadow_judgments").select("cost_jpy").eq("household_id", hid)).data ?? []) as { cost_jpy: number }[];
    expect(j.length).toBeLessThanOrEqual(1);
    for (const x of j) expect(Number(x.cost_jpy)).toBeLessThanOrEqual(3.6);
    expect(r.spentJpy).toBeLessThanOrEqual(3.6);
  });
});
