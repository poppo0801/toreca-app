/**
 * Stage 10K: 本番シャドー用の非同期ワーカー・専用キュー・追記専用の記録の統合テスト（ローカルのSupabase・RLS適用下。AIはすべて台本のモック。架空データのみ。実AI・課金なし）
 *   npm run test:db
 * 確認すること: ①既定OFF・投入の冪等性・世帯の整合 ②RLS（閲覧は世帯の構成員のみ・書き込みは不可） ③許可・モデル・DB設定が欠ければ何もしない
 * ④正常系（記録は非機微・旧方式の表は不変） ⑤二重処理の防止（リース） ⑥失敗の再試行と上限 ⑦緊急停止（DBフラグを実行中に切る） ⑧予算（日次・1件） ⑨機密・非公開の原文は外部へ送らない
 * ⑩画像読み取り・リンク先本文が出典つきで渡り、ID・URLは渡らない ⑪追記専用・保持期限の掃除 ⑫通常収集（旧方式）の結果が、投入あり/なし/失敗でも変わらない
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { buildEvidence, imageReadingsFromExtraction, type StoredEvidence } from "@/lib/collector/evidence";
import { DEFAULT_CONDITIONS } from "@/lib/collector/conditions";
import type { JudgmentInput } from "@/lib/judgment/contract";
import { ScriptedModel } from "@/lib/judgment/model";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import { makeShadowEnqueuer } from "@/lib/server/shadow/queue";
import { runShadowWorker } from "@/lib/server/shadow/worker";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

// 生成済みの型には、この Stage の表・関数が無い。テストでは型を緩めて呼ぶ
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = { rpc: (n: string, a?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>; from: (t: string) => any };
const L = (db: unknown): Loose => db as Loose;
const ENV_ON = { SHADOW_WORKER: "on", SHADOW_ENQUEUE: "on" };
const NOW = new Date();
const TEXT = "ポケモンカード 拡張パック 抽選販売 サンプル電機 三宮店 11/30(月) 23:59まで 兵庫県 応募する";
const robots: SafeFetchResult = { ok: false, code: "robots", message: "このサイトはロボットによるページ取得を許可していません。" };

const answer = (i: JudgmentInput): unknown => ({
  version: "10e.2",
  caseType: { value: "lottery_announcement", basis: "fact", citations: [{ evidenceId: "E1", quote: (i.evidence[0].text ?? "").slice(0, 8) }] },
  structure: { kind: "one_form_one", basis: "inference", rationale: "テスト", citations: [] },
  opportunities: [{ key: "O1", label: "テスト" }],
  relations: [],
  plannedChanges: [],
  unresolved: [],
  nextActions: [{ kind: "none", reason: "テスト" }],
});
const okModel = (cost = 0.2, max = 0.5) => new ScriptedModel((i) => ({ raw: answer(i), costJpy: cost }), undefined, max);

describe.skipIf(!dbTestsEnabled)("Stage 10K: シャドーのキュー・ワーカー・記録（旧方式への非干渉）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hidA: string;
  let hidB: string;
  let profile: string;
  const mk = (n: string) => `https://shadow10k.example.invalid/${n}`;

  const setSettings = async (over: Record<string, unknown> = {}) => {
    const { error } = await admin.from("shadow_settings").upsert({ household_id: hidA, enabled: true, enqueue_enabled: true, daily_budget_jpy: 10, monthly_budget_jpy: 100, per_case_cap_jpy: 3, max_jobs_per_run: 3, retention_days: 30, ...over });
    expect(error).toBeNull();
  };
  /** 保存原文つきの候補を作る（旧方式の抽出済みの状態）。ハッシュを返す */
  const addCandidate = async (n: string, ev: Partial<Parameters<typeof buildEvidence>[0]> | null = {}, via: "x_post" | "web_page" = "x_post", draftOverride?: unknown) => {
    const stored: StoredEvidence | null = ev === null ? null : buildEvidence({ url: mk(n), kind: via, ...(via === "x_post" ? { post: { text: `${TEXT} (${n})`, links: [] } } : { context: `${TEXT} (${n})`, fetchedText: `${TEXT} (${n})`, fetchedVia: "web_fetch" as const }), ...ev }, NOW.toISOString());
    const draft = draftOverride ?? { input: { chain: { name: "サンプル電機" }, store: { name: "三宮店" }, items: [{ product: { name: "拡張パック" } }], applyDeadline: { date: "2099-11-30" }, storeMode: "fixed" } };
    const { data, error } = await u1.from("collection_candidates").insert({ household_id: hidA, dedupe_key: mk(n), source_url: mk(n), title: n, status: "pending", job_state: "review", reasons: [], last_good: (stored ? { evidence: stored } : {}) as never, draft: draft as never }).select("id").single();
    expect(error).toBeNull();
    return { id: data!.id as string, hash: (stored?.hash ?? "").slice(0, 32) };
  };
  const enqueue = async (c: { id: string; hash: string }) => (await L(u1).rpc("shadow_enqueue", { p_household: hidA, p_candidate: c.id, p_hash: c.hash })).data as boolean;
  const jobsOf = async (id: string) => (await admin.from("shadow_jobs").select("*").eq("candidate_id", id)).data ?? [];
  const run = (model: ScriptedModel | null, over: Record<string, unknown> = {}) => runShadowWorker({ db: admin as unknown as Db, model, env: ENV_ON, workerId: "w-test", limit: 5, ...over });
  const clean = async () => {
    await admin.from("shadow_judgments").delete().eq("household_id", hidA);
    await admin.from("shadow_jobs").delete().eq("household_id", hidA);
    await admin.from("collection_candidates").delete().like("dedupe_key", "https://shadow10k.example.invalid/%");
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s10kw", 1);
    const b = await signInTestUser(admin, "s10kw", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hidA = (await u1.rpc("bootstrap_household")).data as string;
    hidB = (await u2.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    await u1.from("collection_settings").insert({ household_id: hidA, auto_register: false, worker_enabled: false });
  });
  afterAll(async () => {
    await clean();
    await cleanupTestUsers(admin, userIds);
  });

  it("①既定はすべてOFF: 設定が無い・enqueue_enabled=false では投入されない。ONにすると投入され、同じ原文は二重に入らない（冪等）。別世帯の候補・不正なハッシュは投入されない", async () => {
    const c = await addCandidate("a1");
    expect(await enqueue(c)).toBe(false); // 設定なし
    await setSettings({ enabled: false, enqueue_enabled: false });
    expect(await enqueue(c)).toBe(false); // 既定OFF
    await setSettings({ enabled: false, enqueue_enabled: true });
    expect(await enqueue(c)).toBe(true);
    expect(await enqueue(c)).toBe(false); // 二重に入らない
    expect(await jobsOf(c.id)).toHaveLength(1);
    expect((await L(u1).rpc("shadow_enqueue", { p_household: hidA, p_candidate: c.id, p_hash: "zz" })).data).toBe(false);
    expect((await L(u2).rpc("shadow_enqueue", { p_household: hidA, p_candidate: c.id, p_hash: c.hash })).data).toBe(false); // 別世帯の利用者は、この世帯へ投入できない
    // 別世帯のIDで、自分の世帯のIDを装っても、候補の所属で拒否される
    const other = await u2.from("collection_candidates").insert({ household_id: hidB, dedupe_key: mk("b1"), source_url: mk("b1"), title: "b1", status: "pending", job_state: "review", reasons: [] }).select("id").single();
    expect((await L(u1).rpc("shadow_enqueue", { p_household: hidA, p_candidate: other.data!.id, p_hash: c.hash })).data).toBe(false);
    await clean();
  });

  it("②RLS: 世帯の構成員は自分の世帯の記録を読めるが、別世帯・匿名は読めない。利用者は設定・キュー・記録を直接書き換えられない", async () => {
    await setSettings({ enabled: true });
    const c = await addCandidate("r1");
    expect(await enqueue(c)).toBe(true);
    await run(okModel());
    expect((await L(u1).from("shadow_jobs").select("id")).data?.length).toBe(1);
    expect((await L(u1).from("shadow_judgments").select("id")).data?.length).toBe(1);
    expect((await L(u1).from("shadow_settings").select("household_id")).data?.length).toBe(1);
    for (const t of ["shadow_jobs", "shadow_judgments", "shadow_settings"]) {
      expect((await L(u2).from(t).select("*")).data ?? [], t).toEqual([]);
      expect((await L(anonClient()).from(t).select("*")).data ?? [], `${t} anon`).toEqual([]);
    }
    expect((await L(u1).from("shadow_settings").update({ daily_budget_jpy: 999 }).eq("household_id", hidA)).error).not.toBeNull();
    expect((await L(u1).from("shadow_settings").insert({ household_id: hidB, enabled: true })).error).not.toBeNull();
    expect((await L(u1).from("shadow_jobs").update({ status: "done" }).eq("household_id", hidA)).error ?? (await L(u1).from("shadow_jobs").select("status").eq("household_id", hidA)).data?.[0]).toBeTruthy();
    expect((await L(u1).from("shadow_judgments").delete().eq("household_id", hidA)).error ?? null).not.toBeUndefined();
    expect((await L(u1).from("shadow_judgments").select("id")).data?.length).toBe(1); // 削除されていない
    expect((await L(u1).rpc("shadow_lease", { p_worker: "x", p_limit: 1, p_lease_seconds: 60 })).error).not.toBeNull(); // 利用者はリースできない
    await clean();
  });

  it("③許可・モデル・DB設定のどれかが欠ければ何もしない（ジョブを確保せず、AIも呼ばない）", async () => {
    await setSettings();
    const c = await addCandidate("g1");
    expect(await enqueue(c)).toBe(true);
    const m = okModel();
    const noPerm = await runShadowWorker({ db: admin as unknown as Db, model: m, env: {}, workerId: "w", limit: 3 });
    expect(noPerm).toMatchObject({ stoppedBy: "not_allowed", notAllowedReason: "off", leased: 0 });
    const killedEnv = await runShadowWorker({ db: admin as unknown as Db, model: m, env: { ...ENV_ON, SHADOW_WORKER_KILL: "1" }, workerId: "w" });
    expect(killedEnv.notAllowedReason).toBe("killed");
    const prod = await runShadowWorker({ db: admin as unknown as Db, model: m, env: { ...ENV_ON, NODE_ENV: "production" }, workerId: "w" });
    expect(prod.notAllowedReason).toBe("production_not_approved"); // 本番では2つ目のスイッチが無ければ動かない
    expect((await run(null)).stoppedBy).toBe("no_model");
    await setSettings({ enabled: false });
    expect((await run(okModel())).stoppedBy).toBe("no_jobs"); // DBの enabled=false の世帯のジョブは確保されない
    expect(m.calls).toBe(0);
    const j = (await jobsOf(c.id))[0];
    expect(j).toMatchObject({ status: "queued", attempts: 0 });
    await clean();
  });

  it("④正常系: 記録は非機微（原文・URL・IDを含まない）・ジョブは done・費用が記録される。旧方式の表と候補の内容は変わらない", async () => {
    await setSettings();
    const tables = ["lotteries", "applications", "collection_candidates", "case_judgments", "notification_deliveries", "lottery_items"];
    const snap = async () => {
      const o: Record<string, string> = {};
      for (const t of tables) o[t] = JSON.stringify((await admin.from(t as never).select("*").eq("household_id" as never, hidA as never)).data ?? (await admin.from(t as never).select("id")).data);
      return o;
    };
    const c = await addCandidate("n1");
    expect(await enqueue(c)).toBe(true);
    const before = await snap();
    const r = await run(okModel(0.2));
    const after = await snap();
    expect(r).toMatchObject({ leased: 1, done: 1, failed: 0 });
    expect(after).toEqual(before);
    const rows = (await admin.from("shadow_judgments").select("*").eq("household_id", hidA)).data!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "accepted", structure_new: "one_form_one", job_id: (await jobsOf(c.id))[0].id });
    expect(Number(rows[0].cost_jpy)).toBeCloseTo(0.2, 3);
    // 記録の本体（record・列）は非機微。内部の候補IDは結合用の列にだけあり、記録の本体には入らない
    const blob = JSON.stringify({ ...rows[0], candidate_id: null });
    for (const bad of ["サンプル電機", "三宮店", "example.invalid", c.id, "evidence.invalid", "11/30"]) expect(blob, bad).not.toContain(bad);
    expect((await jobsOf(c.id))[0]).toMatchObject({ status: "done", locked_by: null });
    expect(((await L(u1).rpc("shadow_stats", { p_household: hidA, p_hours: 24 })).data as { judgments: number; by_status: Record<string, number> }).by_status).toEqual({ accepted: 1 });
    await clean();
  });

  it("⑤二重処理の防止: 2つのワーカーが同時に動いても、各ジョブはちょうど1回だけ処理される（リース）。再実行しても新しい記録は増えない", async () => {
    await setSettings();
    const cs = [await addCandidate("l1"), await addCandidate("l2"), await addCandidate("l3"), await addCandidate("l4")];
    for (const c of cs) expect(await enqueue(c)).toBe(true);
    const m1 = okModel();
    const m2 = okModel();
    const [a, b] = await Promise.all([run(m1, { workerId: "w1", limit: 4 }), run(m2, { workerId: "w2", limit: 4 })]);
    expect(a.done + b.done).toBe(4);
    expect(m1.calls + m2.calls).toBe(4);
    const rows = (await admin.from("shadow_judgments").select("job_id").eq("household_id", hidA)).data!;
    expect(new Set(rows.map((r) => r.job_id)).size).toBe(4);
    expect(rows).toHaveLength(4);
    expect((await run(okModel())).stoppedBy).toBe("no_jobs");
    await clean();
  });

  it("⑥失敗の再試行: モデルの失敗は指数バックオフで再投入され、試行の上限で failed。リースが切れたジョブは別のワーカーが引き継ぐ（上限まで）", async () => {
    await setSettings();
    const c = await addCandidate("f1");
    expect(await enqueue(c)).toBe(true);
    const bad = new ScriptedModel(() => { throw new Error("boom"); }, undefined, 0.5);
    for (let k = 1; k <= 3; k++) {
      const r = await run(bad);
      expect(r.leased).toBe(1);
      const j = (await jobsOf(c.id))[0];
      if (k < 3) {
        expect(j).toMatchObject({ status: "queued", attempts: k });
        expect(new Date(j.next_run_at).getTime()).toBeGreaterThan(Date.now()); // バックオフ
        await admin.from("shadow_jobs").update({ next_run_at: new Date(Date.now() - 1000).toISOString() }).eq("id", j.id);
      } else expect(j).toMatchObject({ status: "failed", attempts: 3 });
    }
    expect((await run(okModel())).stoppedBy).toBe("no_jobs"); // failed は再確保されない
    // リース切れの引き継ぎ
    const c2 = await addCandidate("f2");
    await enqueue(c2);
    const j2 = (await jobsOf(c2.id))[0];
    await admin.from("shadow_jobs").update({ status: "leased", attempts: 1, locked_by: "dead-worker", lease_until: new Date(Date.now() - 60_000).toISOString() }).eq("id", j2.id);
    const ok = okModel();
    expect((await run(ok)).done).toBe(1);
    expect((await jobsOf(c2.id))[0]).toMatchObject({ status: "done", attempts: 2 });
    await clean();
  });

  it("⑦緊急停止: 実行中にDBの enabled を false にすると、次のジョブはAIを呼ばず確保を解除して戻される（再デプロイ不要）。キューは失われない", async () => {
    await setSettings();
    const cs = [await addCandidate("k1"), await addCandidate("k2"), await addCandidate("k3")];
    for (const c of cs) await enqueue(c);
    let n = 0;
    const m = new ScriptedModel(async (i) => {
      if (n++ === 0) await admin.from("shadow_settings").update({ enabled: false }).eq("household_id", hidA); // 1件目の処理中に緊急停止
      return { raw: answer(i), costJpy: 0.2 };
    }, undefined, 0.5);
    const r = await run(m);
    expect(m.calls).toBe(1); // 2件目以降は呼ばれない
    expect(r.byReason.killed).toBe(2);
    const statuses = (await admin.from("shadow_jobs").select("status,locked_by,attempts").eq("household_id", hidA)).data!;
    expect(statuses.filter((s) => s.status === "done")).toHaveLength(1);
    expect(statuses.filter((s) => s.status === "queued" && s.locked_by === null && s.attempts === 0)).toHaveLength(2); // 罰なしで戻る
    // 再開（enabled=true）すると続きから処理される
    await setSettings();
    await admin.from("shadow_jobs").update({ next_run_at: new Date(Date.now() - 1000).toISOString() }).eq("household_id", hidA).eq("status", "queued");
    expect((await run(okModel())).done).toBe(2);
    await clean();
  });

  it("⑧予算: 日次の上限を超える呼び出しはしない（事前予約）。超える分は翌日へ保留。上限0なら実行しない。1件の上限も守る", async () => {
    await setSettings({ daily_budget_jpy: 0.9 });
    const cs = [await addCandidate("b1x"), await addCandidate("b2x"), await addCandidate("b3x")];
    for (const c of cs) await enqueue(c);
    const m = okModel(0.4, 0.5);
    const r = await run(m);
    expect(m.calls).toBe(2); // 0.9 → 0.5 → 0.1。3件目の予約(0.5)は残額を超える
    expect(r.byReason.budget).toBe(1);
    const spent = (await admin.from("shadow_judgments").select("cost_jpy").eq("household_id", hidA)).data!.reduce((a, x) => a + Number(x.cost_jpy), 0);
    expect(spent).toBeLessThanOrEqual(0.9 + 1e-9);
    const held = (await admin.from("shadow_jobs").select("next_run_at,last_error").eq("household_id", hidA).eq("last_error", "budget")).data!;
    expect(held).toHaveLength(1);
    expect(new Date(held[0].next_run_at).getTime()).toBeGreaterThan(Date.now() + 60_000); // 翌日以降
    await clean();
    await setSettings({ daily_budget_jpy: 0 });
    const c = await addCandidate("b4x");
    await enqueue(c);
    const m0 = okModel();
    await run(m0);
    expect(m0.calls).toBe(0);
    await clean();
    await setSettings({ per_case_cap_jpy: 0.3 }); // 1件の上限が見込み費用(0.5)より小さい場合は、上限(0.3)で予約する＝呼べる。コストが上限を超えたら予算超過として止まる
    const c5 = await addCandidate("b5x");
    await enqueue(c5);
    const mm = new ScriptedModel((i) => ({ raw: answer(i), costJpy: 0.9 }), undefined, 0.5);
    await run(mm);
    const rec = (await admin.from("shadow_judgments").select("status,cost_jpy").eq("household_id", hidA)).data!;
    expect(rec.every((x) => x.status === "budget_stopped" || Number(x.cost_jpy) <= 0.3 + 1e-9 || x.cost_jpy === null)).toBe(true);
    await clean();
  });

  it("⑨機密・非公開の原文は外部へ送らない: 認証情報の実値・非公開の取得方法・原文なしは skipped（モデルは呼ばれない）。公開応募ページの定型の項目名では除外しない", async () => {
    await setSettings();
    const secret = `${TEXT} ${["session", "id="].join("")}${"ab12".repeat(5)}`; // 保存時の伏せ字では消えない種類の秘密（実行時に組み立てる）
    const apiKey = ["sk-", "ant-", "q".repeat(30)].join(""); // 伏せ字で消える種類（外部へは出ないことを別に確認）
    const cs = {
      secret: await addCandidate("s1", { post: { text: secret, links: [] } }),
      card: await addCandidate("s2", { card: TEXT, viaList: true, fetchedText: undefined, fetchedVia: undefined } as never, "web_page"),
      masked: await addCandidate("s5", { post: { text: `${TEXT} ${apiKey}`, links: [] } }),
      none: await addCandidate("s3", null),
      form: await addCandidate("s4", { post: { text: TEXT, links: [] }, linkedPages: [{ url: "https://shop.example.com/form", text: "応募フォーム お名前（必須） メールアドレス（必須） 電話番号 ご住所 を入力してください。応募期間は11/30まで。" }] }),
    };
    // 保存時の伏せ字（redact）をすり抜けた想定で、保存済みの本文に秘密の実値を直接入れる（ワーカー側の最終検査の確認）
    const lg = (await admin.from("collection_candidates").select("last_good").eq("id", cs.secret.id).single()).data!.last_good as { evidence: { text: string } };
    await admin.from("collection_candidates").update({ last_good: { evidence: { ...lg.evidence, text: secret } } }).eq("id", cs.secret.id);
    for (const c of Object.values(cs)) await enqueue(c);
    const sent: string[] = [];
    const m = new ScriptedModel((i) => { sent.push(JSON.stringify(i)); return { raw: answer(i), costJpy: 0.2 }; }, undefined, 0.5);
    const r = await run(m, { limit: 6 });
    expect(sent.join("")).not.toContain(apiKey);
    expect(sent.join("")).not.toContain("ab12ab12");
    expect(r.byReason).toMatchObject({ secret_detected: 1 });
    expect(r.skipped).toBeGreaterThanOrEqual(2);
    expect(m.calls).toBe(2); // 公開応募ページの項目名だけのもの（form）と、伏せ字で消えた（masked）だけがAIに渡る。秘密の実値・非公開の取得方法・原文なしは呼ばれない
    expect((await jobsOf(cs.card.id))[0]).toMatchObject({ status: "skipped", skip_reason: "not_public" });
    expect((await jobsOf(cs.secret.id))[0]).toMatchObject({ status: "skipped", skip_reason: "secret_detected" });
    expect(await jobsOf(cs.none.id)).toEqual([]); // 原文が無い候補は、そもそも投入されない
    expect((await jobsOf(cs.form.id))[0]).toMatchObject({ status: "done" });
    await clean();
  });

  it("⑩画像読み取り・リンク先本文は出典つきの別の根拠として渡る。登録値は currentCase（画像由来の印つき）。ID・実URL・保護情報は渡らない", async () => {
    await setSettings();
    const ex = { evidence: { applyDeadline: { quote: "応募締切 11/30 23:59", source: "画像1枚目" } }, confidence: { applyDeadline: "high" } as Record<string, string> };
    const c = await addCandidate("i1", { post: { text: TEXT, links: [], images: ["https://img.example.com/a.jpg"] }, imageReadings: imageReadingsFromExtraction(ex, NOW.toISOString()), imageStatus: "fetched", linkedPages: [{ url: "https://shop.example.com/detail", text: "架空店の詳細。応募期間は11/20から11/30まで。当選発表は12/3です。" }] } as never);
    await enqueue(c);
    const seen: JudgmentInput[] = [];
    const m = new ScriptedModel((i) => { seen.push(i); return { raw: answer(i), costJpy: 0.2 }; }, undefined, 0.5);
    expect((await run(m)).done).toBe(1);
    const i = seen[0];
    expect(i.evidence.map((e) => e.kind ?? "post")).toEqual(["post", "linked_page", "image_reading"]);
    expect(i.evidence.find((e) => e.kind === "image_reading")?.text).toContain("画像1枚目");
    expect(i.currentCase).toMatchObject({ chain: "サンプル電機", store: "三宮店", storeMode: "fixed" });
    const json = JSON.stringify(i);
    for (const bad of [c.id, hidA, "shadow10k.example.invalid", "shop.example.com", "img.example.com", "protectedCodes", "household"]) expect(json, bad).not.toContain(bad);
    expect(i.evidence.every((e) => e.url.startsWith("https://evidence.invalid/"))).toBe(true);
    await clean();
  });

  it("⑪追記専用・保持期限: 記録は更新できない。期限（retention_days）を過ぎた記録と終了済みジョブだけが掃除される。利用者は掃除を呼べない", async () => {
    await setSettings({ retention_days: 7 });
    const c = await addCandidate("p1");
    await enqueue(c);
    await run(okModel());
    const row = (await admin.from("shadow_judgments").select("id").eq("household_id", hidA)).data![0];
    expect((await admin.from("shadow_judgments").update({ status: "error" }).eq("id", row.id)).error).not.toBeNull(); // 更新不可
    const old = await admin.from("shadow_judgments").insert({ household_id: hidA, prompt_version: "t", model_id: "t", status: "accepted", record: {}, created_at: new Date(Date.now() - 30 * 86_400_000).toISOString() }).select("id").single();
    expect(old.error).toBeNull();
    expect((await L(u1).rpc("shadow_purge")).error).not.toBeNull();
    const purged = await admin.rpc("shadow_purge");
    expect(purged.error).toBeNull();
    const left = (await admin.from("shadow_judgments").select("id").eq("household_id", hidA)).data!.map((x) => x.id);
    expect(left).toContain(row.id);
    expect(left).not.toContain(old.data!.id);
    await clean();
  });

  it("⑬一覧投稿: 登録値（対象）に関係する項目だけをAIに渡す。対象が特定できない・登録値が無いときは判断しない（推測で結び付けない）", async () => {
    await setSettings();
    const list = "🌋架空地方 | 3件 (1/1) 《サンプル電機 三宮店（兵庫県）- 1件》 ・架空TCG 拡張パック https://t.co/aa - 11/30(月)23:59〆 《ほかの系列 北店（大阪府）- 1件》 ・架空TCG 拡張パック https://t.co/bb - 12/1(火)23:59〆 《別の系列 南店（東京都）- 1件》 ・架空TCG 拡張パック https://t.co/cc - 12/2(水)23:59〆";
    const hit = await addCandidate("li1", { post: { text: list, links: [] } });
    const miss = await addCandidate("li2", { post: { text: list, links: [] } }, "x_post", { input: { chain: { name: "存在しない系列" }, store: { name: "存在しない店" }, items: [], storeMode: "fixed" } });
    const nocase = await addCandidate("li3", { post: { text: list, links: [] } }, "x_post", {});
    for (const c of [hit, miss, nocase]) expect(await enqueue(c)).toBe(true);
    const sent: JudgmentInput[] = [];
    const m = new ScriptedModel((i) => { sent.push(i); return { raw: answer(i), costJpy: 0.2 }; }, undefined, 0.5);
    const r = await run(m);
    expect(m.calls).toBe(1);
    const text = sent[0].evidence[0].text ?? "";
    expect(text).toContain("三宮店");
    expect(text).toContain("架空地方"); // 共通の見出しは保持
    expect(text).not.toContain("ほかの系列");
    expect(text).not.toContain("別の系列");
    expect((await jobsOf(miss.id))[0]).toMatchObject({ status: "skipped", skip_reason: "list_target_unidentified" });
    expect((await jobsOf(nocase.id))[0]).toMatchObject({ status: "skipped", skip_reason: "list_without_case" });
    expect(r.done).toBe(1);
    await clean();
  });

  it("⑫旧方式（通常収集）の結果は、投入あり・投入なし・投入の失敗のどれでも同じ。投入ありのときだけキューに1件入り、AIは呼ばれない", async () => {
    await setSettings({ enabled: false }); // ワーカーは動かさない（キューへの投入だけを見る）
    const deps = (enqueuer?: CollectDeps["shadowEnqueue"]): CollectDeps => ({
      db: u1, householdId: hidA, trigger: "manual", now: NOW, actor: profile, canRegister: true,
      extractor: { engine: "mock", extract: async (r) => getExtractor({ AI_PROVIDER: "mock" })!.extract(r) },
      xClient: null, fetchPage: async () => robots, fetchOembed: async () => ({ ok: false, message: "x" }),
      ...(enqueuer ? { shadowEnqueue: enqueuer } : {}),
    });
    const tables = ["lotteries", "applications", "collection_candidates", "case_judgments", "notification_deliveries"];
    const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await u1.from(t as never).select("id", { count: "exact", head: true })).count ?? -1])));
    const once = async (label: string, enqueuer?: CollectDeps["shadowEnqueue"]) => {
      const url = mk("legacy");
      const queued = { kind: "web_page", url, title: "応募する", context: TEXT, sourceName: "pokeso", attempts: 0 };
      await u1.from("collection_candidates").insert({ household_id: hidA, dedupe_key: url, source_url: url, title: label, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued } });
      const before = await counts();
      const out = await processQueue(deps(enqueuer), { settings: { auto_register: false }, cond: DEFAULT_CONDITIONS, data: await loadAppData(u1, hidA), aiLeft: 20, timeLeft: () => 50_000, perBatch: 4 });
      const r = (await u1.from("collection_candidates").select("id,status,job_state,fail_kind,reasons,ai_calls,triage,triage_reason,draft").eq("dedupe_key", url).single()).data!;
      const after = await counts();
      const view = JSON.stringify({ s: r.status, j: r.job_state, f: r.fail_kind, re: r.reasons, a: r.ai_calls, t: r.triage, d: JSON.stringify(r.draft).split(url).join("<URL>"), out: { p: out.processed, ai: out.aiCalls, reg: out.registered }, delta: Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]])) });
      const jobs = (await admin.from("shadow_jobs").select("id").eq("candidate_id", r.id)).data!.length;
      await u1.from("collection_candidates").delete().eq("dedupe_key", url);
      return { view, jobs };
    };
    await once("warm1");
    await once("warm2"); // 旧方式は同じドメインの取得制限を学習する（実行の順序で変わる）。学習が済んだ状態で比較するため、先に1回流す
    const base = await once("off");
    const withQ = await once("on", makeShadowEnqueuer(u1, hidA, ENV_ON));
    const failing = await once("fail", async () => { throw new Error("enqueue down"); });
    const hang = await once("hang", () => new Promise<boolean>(() => undefined).then(() => true)); // 永久に返らない投入口は、待たずに…（※下で時間を検査）
    expect(base.jobs).toBe(0);
    expect(JSON.parse(withQ.view)).toEqual(JSON.parse(base.view));
    expect(JSON.parse(failing.view)).toEqual(JSON.parse(base.view));
    expect(JSON.parse(hang.view)).toEqual(JSON.parse(base.view));
    expect(withQ.jobs).toBe(1);
  }, 120_000);
});
