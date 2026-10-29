// @vitest-environment node
/**
 * Stage 5G の結合テスト（実Supabase・RLS適用下・AIはモックエンジン）: 一括解析ジョブの作成・解析・状態・重複・予算・同時実行・認可・保存の記録。
 *   npm run test:db   ※ マイグレーション 20261030000025/26 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJob, dedupeKey, getJob, jobAction, listJobs, processJobs } from "@/lib/server/ai-job-service";
import { saveLottery, type Db } from "@/lib/server/lottery-service";
import type { LotteryInput } from "@/lib/lottery-input";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const text = (n: number) => `【抽選販売のお知らせ${n}】サンプル電機 三宮店。拡張パック「ひかりの森」の抽選。応募は1月20日23:59まで。`;

describe.skipIf(!dbTestsEnabled)("Stage 5G: 一括解析のジョブ", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  let a1: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
  const x = (db: Db) => db as any;
  const prevProvider = process.env.AI_PROVIDER;
  const prevKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    process.env.AI_PROVIDER = "mock";
    const a = await signInTestUser(admin, "s5g", 1);
    const b = await signInTestUser(admin, "s5g", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    a1 = (await u1.from("profiles").select("id,label")).data!.find((p) => p.label === "A")!.id;
  });
  afterAll(async () => {
    process.env.AI_PROVIDER = prevProvider;
    process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevProvider === undefined) delete process.env.AI_PROVIDER;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    await cleanupTestUsers(admin, ids);
  });

  let jobId: string;
  let itemIds: string[] = [];

  it("複数の項目（文章・URL）を1つのジョブにできる。同じ内容は重複として追加されない。他世帯の画像は指定できない", async () => {
    const r = await createJob(u1, hid1, a1, {
      label: "テスト",
      items: [
        { source: "text", text: text(1) },
        { source: "text", text: text(2) },
        { source: "url", url: "http://169.254.169.254/latest/meta-data/" }, // 内部アドレス（SSRF対策の確認）
        { source: "text", text: text(1) }, // ジョブ内の重複
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    jobId = r.jobId;
    expect(r.created).toBe(3);
    expect(r.skipped).toEqual([{ index: 3, reason: "同じ内容の項目が重複しています" }]);
    const detail = await getJob(u1, jobId);
    expect(detail.ok && detail.items.map((i) => i.status)).toEqual(["queued", "queued", "queued"]);
    itemIds = detail.ok ? detail.items.map((i) => i.id) : [];
    // 解析中・確認待ちと同じ内容は、別のジョブでも追加できない（二重解析・二重登録の防止）
    const dup = await createJob(u1, hid1, a1, { label: "", items: [{ source: "text", text: text(2) }] });
    expect(dup.ok).toBe(false);
    // 他世帯の画像パスは不可。項目数・文章の長さの上限
    const evil = await createJob(u1, hid1, a1, { label: "", items: [{ source: "images", paths: [`${hid2}/${crypto.randomUUID()}.png`], shas: ["a".repeat(64)] }] });
    expect(evil.ok).toBe(false);
    expect((await createJob(u1, hid1, a1, { label: "", items: Array.from({ length: 21 }, (_, i) => ({ source: "text" as const, text: text(100 + i) })) })).ok).toBe(false);
    expect((await createJob(u1, hid1, a1, { label: "", items: [{ source: "text", text: "短い" }] })).ok).toBe(false);
    // 重複キー: URLの表記ゆれ・X投稿ID
    expect(dedupeKey({ source: "url", url: "https://Example.com/a/?utm_source=x#top" })).toBe(dedupeKey({ source: "url", url: "https://example.com/a" }));
    expect(dedupeKey({ source: "x_url", url: "https://x.com/s/status/1234567890123" })).toBe(dedupeKey({ source: "x_url", url: "https://twitter.com/other/status/1234567890123?s=20" }));
  });

  it("解析を実行すると、文章は「確認待ち」の結果になり、内部アドレスのURLは取得せずに失敗する（再試行もしない）。解析ログ（費用）が記録される", async () => {
    const r = await processJobs(u1, hid1, { budgetMs: 30_000 });
    expect(r.processed).toBeGreaterThanOrEqual(3);
    const d = await getJob(u1, jobId);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const [t1, t2, url] = d.items;
    expect(t1.status).toBe("done");
    expect(t2.status).toBe("done");
    expect(url.status).toBe("failed");
    expect(url.errorCode).toBe("fetch_failed");
    expect(url.attempts).toBe(1); // 取得の失敗は自動で再試行しない
    expect(d.job.status).toBe("partial");
    expect(d.job.done).toBe(2);
    // 結果は検証済みの抽出結果（正式な抽選ではない）
    expect(t1.result?.extraction).toMatchObject({ chainName: "サンプル電機", storeName: "三宮店" });
    expect(t1.lotteryId).toBeNull();
    expect((await x(u1).from("lotteries").select("id")).data ?? []).toHaveLength(0);
    // 解析ログ
    const logs = (await x(u1).from("ai_extraction_logs").select("id,kind,prompt_version,extraction").in("id", [t1.runId, t2.runId].filter(Boolean))).data;
    expect(logs).toHaveLength(2);
    expect(logs[0].extraction).toBeTruthy();
  });

  it("再試行・除外・既読・キャンセル。確認待ちの項目と同じ内容は、除外すると改めて追加できる", async () => {
    expect((await jobAction(u1, jobId, { action: "retry", itemId: itemIds[2] })).ok).toBe(true);
    expect((await getJob(u1, jobId).then((d) => (d.ok ? d.items[2].status : ""))) as string).toBe("queued");
    await processJobs(u1, hid1, { budgetMs: 30_000 });
    expect((await getJob(u1, jobId).then((d) => (d.ok ? d.items[2].status : ""))) as string).toBe("failed");
    // 除外
    expect((await jobAction(u1, jobId, { action: "skip", itemId: itemIds[2] })).ok).toBe(true);
    // 確認待ちと同じ内容は追加できないが、除外すれば追加できる
    expect((await createJob(u1, hid1, a1, { label: "", items: [{ source: "text", text: text(1) }] })).ok).toBe(false);
    expect((await jobAction(u1, jobId, { action: "skip", itemId: itemIds[1] })).ok).toBe(true);
    const again = await createJob(u1, hid1, a1, { label: "再", items: [{ source: "text", text: text(2) }] });
    expect(again.ok).toBe(true);
    // 既読
    expect((await jobAction(u1, jobId, { action: "seen" })).ok).toBe(true);
    expect((await listJobs(u1)).jobs.find((j) => j.id === jobId)?.seenAt).toBeTruthy();
    // キャンセル（待機中の項目だけが取り消される）
    if (again.ok) {
      expect((await jobAction(u1, again.jobId, { action: "cancel" })).ok).toBe(true);
      const c = await getJob(u1, again.jobId);
      expect(c.ok && c.items[0].status).toBe("cancelled");
      expect(c.ok && c.job.status).toBe("cancelled");
    }
  });

  it("保存した抽選と項目を結びつけられるのは1回だけ。フィードバック（修正の記録）が解析ジョブの実行IDで残る", async () => {
    const chain = (await u1.from("chains").insert({ household_id: hid1, name: "サンプル電機" }).select("id").single()).data!.id;
    const prod = (await u1.from("products").insert({ household_id: hid1, official_name: "拡張パック「ひかりの森」", packs_per_box: 30 }).select("id").single()).data!.id;
    const d = await getJob(u1, jobId);
    if (!d.ok) throw new Error("job");
    const item = d.items[0];
    expect(item.status).toBe("done");
    const base: LotteryInput = {
      chain: { id: chain, name: "" },
      store: { id: null, name: "三宮店", prefecture: "" },
      multiMode: "single",
      campaignId: null,
      newCampaign: null,
      items: [{ id: null, product: { id: prod, name: "" }, quantity: 1, unit: "box" }],
      applyStart: { precision: "unknown", date: "", time: "" },
      applyDeadline: { precision: "date_time", date: "2027-01-20", time: "23:59" },
      resultDate: { precision: "date_only", date: "2027-01-25", time: "" },
      procedureStart: { precision: "unknown", date: "", time: "" },
      procedureDeadline: { precision: "unknown", date: "", time: "" },
      receiveMethod: "store",
      applyMethod: "web",
      conditionsText: "",
      verificationText: "",
      announcementMethod: "",
      announcementUrl: "",
      sourceUrls: [],
      eventState: "open",
      limitBasis: "person",
      limitMaxCount: 1,
      memo: "",
      applications: [],
      appliedAt: "",
    };
    const filled = { ...base };
    base.aiFeedback = { runId: item.runId as string, filled: filled as unknown as Record<string, unknown>, reason: null };
    const saved = await saveLottery(u1, hid1, null, base, a1);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const lotteryId = saved.value.id;
    expect((await jobAction(u1, jobId, { action: "saved", itemId: item.id, lotteryId })).ok).toBe(true);
    const after = await getJob(u1, jobId);
    expect(after.ok && after.items[0]).toMatchObject({ status: "saved", lotteryId });
    // 二度目は無効（二重保存の防止）。別の抽選にも結びつけられない
    const second = await jobAction(u1, jobId, { action: "saved", itemId: item.id, lotteryId });
    expect(second.ok && second.marked).toBe(false);
    // フィードバックは解析の実行IDで1件
    const fb = (await x(u1).from("ai_extraction_feedback").select("run_id,lottery_id").eq("run_id", item.runId)).data;
    expect(fb).toEqual([{ run_id: item.runId, lottery_id: lotteryId }]);
    // 同じ抽選に結びつく項目は1つだけ（DBの一意制約）
    const other = await getJob(u1, jobId);
    const spare = other.ok ? other.items.find((i) => i.status === "failed" || i.status === "skipped") : undefined;
    if (spare) expect((await x(u1).from("ai_job_items").update({ lottery_id: lotteryId }).eq("id", spare.id)).error).not.toBeNull();
  });

  it("同時実行は世帯ごとに3件まで。取り出し済みの項目は期限まで他から取れず、世帯は独立している", async () => {
    const r = await createJob(u2, hid2, null, { label: "", items: Array.from({ length: 5 }, (_, i) => ({ source: "text" as const, text: text(200 + i) })) });
    expect(r.ok).toBe(true);
    const first = await x(u2).rpc("claim_ai_job_items", { p_limit: 5, p_lease_secs: 90 });
    expect(first.data).toHaveLength(3);
    const second = await x(u2).rpc("claim_ai_job_items", { p_limit: 5, p_lease_secs: 90 });
    expect(second.data).toHaveLength(0); // 3件が解析中の間は、追加で取り出せない
    // 別の世帯は影響を受けない（自分の待機中の項目だけを取り出せる）
    const mine = await x(u1).rpc("claim_ai_job_items", { p_limit: 3, p_lease_secs: 90 });
    expect((mine.data as { household_id: string }[]).every((i) => i.household_id === hid1)).toBe(true);
    // 期限切れの項目は回収され、試行回数が増える（上限3回）。上限に達したら失敗になる
    await x(admin).from("ai_job_items").update({ lease_until: new Date(Date.now() - 1000).toISOString(), attempts: 3 }).eq("household_id", hid2).eq("status", "running");
    const third = await x(u2).rpc("claim_ai_job_items", { p_limit: 5, p_lease_secs: 90 });
    expect(third.data).toHaveLength(2); // 未着手の2件。上限に達した3件は取り出さず失敗にする
    const failed = (await x(u2).from("ai_job_items").select("status,error_code").eq("error_code", "timeout")).data;
    expect(failed).toHaveLength(3);
    expect(failed[0].status).toBe("failed");
  });

  it("月間予算に達していると、新しい解析を始めない（項目は待機のまま残る）", async () => {
    // 実AIのエンジンで予算0円にして、呼び出さずに停止することを確かめる（キーはダミー。APIは呼ばれない）
    process.env.AI_PROVIDER = "";
    process.env.ANTHROPIC_API_KEY = "test-key-never-used";
    expect((await x(u1).rpc("save_household_settings", { p_card_display: {}, p_bands: [5, 15, 30, 60], p_budget: 0, p_auto_ai: true, p_actor: a1 })).error).toBeNull();
    const r = await createJob(u1, hid1, a1, { label: "予算", items: [{ source: "text", text: text(300) }] });
    expect(r.ok).toBe(true);
    const p = await processJobs(u1, hid1, { budgetMs: 5000 });
    expect(p).toMatchObject({ processed: 0, blocked: true, pending: true });
    const list = await listJobs(u1);
    expect(list.blocked).toBe(true);
    if (r.ok) {
      const d = await getJob(u1, r.jobId);
      expect(d.ok && d.items[0].status).toBe("queued");
    }
    process.env.AI_PROVIDER = "mock";
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("認可: 他世帯のジョブ・項目は見えず、操作できない。未ログインは不可。入力画像のストレージも自世帯のみ", async () => {
    expect((await x(u2).from("ai_jobs").select("id").eq("id", jobId)).data ?? []).toHaveLength(0);
    expect((await getJob(u2, jobId)).ok).toBe(false);
    expect((await jobAction(u2, jobId, { action: "skip", itemId: itemIds[0] })).ok).toBe(true); // 他世帯には何も起きない（0行の更新）
    expect((await getJob(u1, jobId).then((d) => (d.ok ? d.items[0].status : ""))) as string).toBe("saved");
    expect((await x(u2).from("ai_job_items").insert({ household_id: hid1, job_id: jobId, source_kind: "text", source_text: "x" })).error).not.toBeNull();
    expect((await x(anonClient() as unknown as Db).from("ai_jobs").select("id")).data ?? []).toHaveLength(0);
    expect((await x(anonClient() as unknown as Db).rpc("claim_ai_job_items", { p_limit: 1 })).error).not.toBeNull();
    const path = `${hid1}/${crypto.randomUUID()}.png`;
    expect((await u1.storage.from("job-inputs").upload(path, PNG, { contentType: "image/png" })).error).toBeNull();
    expect((await u2.storage.from("job-inputs").download(path)).error).not.toBeNull();
    expect((await u2.storage.from("job-inputs").upload(`${hid1}/evil.png`, PNG, { contentType: "image/png" })).error).not.toBeNull();
    expect((await anonClient().storage.from("job-inputs").download(path)).error).not.toBeNull();
    expect((await u1.storage.from("job-inputs").remove([path])).error).toBeNull();
  });
});
