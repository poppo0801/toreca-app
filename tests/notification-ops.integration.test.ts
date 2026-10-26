/**
 * 通知運用の結合テスト（実Supabase）: 誰に通知されるか／されないか、定期実行の重複防止・再試行・エラー記録、
 * 起動関数の権限。実際のプッシュ送信は行わない（偽の送信関数）。  npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX, flexToInput, type LotteryInput } from "@/lib/lottery-input";
import { saveLottery, setApplied, setManaged, type Db } from "@/lib/server/lottery-service";
import { runNotifyJob } from "@/lib/server/notify-job";
import type { PushResult, PushSender } from "@/lib/server/push";
import { addSkipRule, setProfileTargets } from "@/lib/server/rules-service";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const FCM = "https://fcm.googleapis.com/fcm/send/";

describe.skipIf(!dbTestsEnabled)("通知運用の検証", () => {
  const admin = adminClient();
  const adminDb = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profA: string;
  let profB: string;
  let profC: string;
  let chainId: string;
  let chain2Id: string;
  let storeId: string;
  let store2Id: string;
  let productId: string;
  let accA: string;
  const endpoints: Record<string, string> = {};

  const sent: { endpoint: string; title: string; body: string }[] = [];
  let behavior: "ok" | "fail" | "throw" = "ok";
  const sender: PushSender = async (sub, payload): Promise<PushResult> => {
    sent.push({ endpoint: sub.endpoint, title: payload.title, body: payload.body });
    if (behavior === "throw") throw new Error("boom: secret-detail");
    return behavior === "ok" ? { ok: true } : { ok: false, gone: false, status: 503 };
  };
  const toWho = (e: string) => Object.entries(endpoints).find(([, v]) => v === e)?.[0];
  const recipients = (needle: string) => sent.filter((s) => s.body.includes(needle)).map((s) => toWho(s.endpoint)).sort();

  const ok = <T,>(r: { ok: boolean; value?: T; error?: string }) => {
    expect(r.ok, r.error).toBe(true);
    return (r as { value: T }).value;
  };
  const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    expect(error).toBeNull();
    return data as { id: string };
  };
  const soon = (min: number) => flexToInput({ precision: "date_time", at: new Date(Date.now() + min * 60_000).toISOString() });
  const input = (over: Partial<LotteryInput>): LotteryInput => ({
    chainId,
    storeId,
    campaignId: null,
    newCampaign: null,
    items: [{ productId, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX,
    applyDeadline: soon(10),
    resultDate: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "store",
    applyMethod: "web",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "account",
    limitMaxCount: 1,
    memo: "",
    applications: [],
    appliedAt: "",
    ...over,
  });
  const job = (extra: Partial<Parameters<typeof runNotifyJob>[2]> = {}) => runNotifyJob(adminDb, sender, { onlyHousehold: hid, ...extra });
  const clearDeliveries = () => admin.from("notification_deliveries").delete().eq("household_id", hid);
  // 本番の実行履歴を消さないよう、このテストで作った行（開始時刻以降・固定の行）だけを削除する
  const testStart = new Date().toISOString();
  const fixtureIds: string[] = [];
  const clearRuns = async () => {
    await admin.from("notification_job_runs").delete().gte("started_at", testStart);
    if (fixtureIds.length > 0) await admin.from("notification_job_runs").delete().in("id", fixtureIds);
  };
  const insertRun = async (row: { status: string; started_at: string }) => {
    const { data } = await admin.from("notification_job_runs").insert(row).select("id").single();
    if (data) fixtureIds.push(data.id);
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "ops", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    const profiles = (await u1.from("profiles").select("id,label")).data!;
    profA = profiles.find((p) => p.label === "A")!.id;
    profB = profiles.find((p) => p.label === "B")!.id;
    profC = profiles.find((p) => p.label === "C")!.id;

    chainId = (await must(u1.from("chains").insert({ household_id: hid, name: "運用電機" }).select("id").single())).id;
    chain2Id = (await must(u1.from("chains").insert({ household_id: hid, name: "運用玩具" }).select("id").single())).id;
    storeId = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "本店" }).select("id").single())).id;
    store2Id = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "支店" }).select("id").single())).id;
    await must(u1.from("stores").insert({ household_id: hid, chain_id: chain2Id, name: "玩具店" }).select("id").single());
    productId = (await must(u1.from("products").insert({ household_id: hid, official_name: "運用商品", packs_per_box: 20 }).select("id").single())).id;
    const fam = (await must(u1.from("family_groups").insert({ household_id: hid, label: "家族" }).select("id").single())).id;
    const adr = (await must(u1.from("address_groups").insert({ household_id: hid, label: "住所" }).select("id").single())).id;
    const idA = (await must(u1.from("identities").insert({ household_id: hid, display_label: "名義A", family_group_id: fam, address_group_id: adr }).select("id").single())).id;
    const idB = (await must(u1.from("identities").insert({ household_id: hid, display_label: "名義B", family_group_id: fam, address_group_id: adr }).select("id").single())).id;
    const acc = (identity: string, profile: string, label: string, chain = chainId) =>
      must(u1.from("service_accounts").insert({ household_id: hid, chain_id: chain, identity_id: identity, managed_by_profile_id: profile, account_label: label, membership_state: "eligible" }).select("id").single()).then((r) => r.id);
    accA = await acc(idA, profA, "A-acc");
    await acc(idB, profB, "B-acc");
    await acc(idB, profC, "C-acc");
    for (const [who, profile] of [["A", profA], ["B", profB], ["C", profC]] as const) {
      endpoints[who] = `${FCM}ops-${who}-${crypto.randomUUID()}`;
      const { error } = await u1.rpc("register_push_subscription", { p_endpoint: endpoints[who], p_p256dh: "p".repeat(20), p_auth: "a".repeat(16), p_profile: profile, p_label: who });
      expect(error).toBeNull();
    }
  });

  afterAll(async () => {
    await clearRuns();
    await cleanupTestUsers(admin, userIds);
  });

  it("未応募のアカウントを担当するプロフィールの端末にだけ届く", async () => {
    sent.length = 0;
    await clearDeliveries();
    ok(await saveLottery(u1, hid, null, input({ memo: "ELIGIBLE" }), profA));
    const r = await job();
    expect(r.ok && !r.skipped).toBe(true);
    // A・B・C それぞれが自分のアカウントについて未応募 → 各自の端末に1件ずつ
    expect(recipients("ELIGIBLE".length ? "運用電機 本店" : "")).toEqual(["A", "B", "C"]);
    for (const w of ["A", "B", "C"]) expect(sent.filter((s) => s.endpoint === endpoints[w])).toHaveLength(1);
    expect(sent.find((s) => s.endpoint === endpoints.A)!.body).toContain("A-acc");
    expect(sent.find((s) => s.endpoint === endpoints.A)!.body).not.toContain("B-acc");
  });

  it("応募済み・スルー・対象外・枠充足・要確認・★OFFのプロフィールには通知されない", async () => {
    sent.length = 0;
    await clearDeliveries();
    // この検証用の別店舗（支店）に絞って確認するため、既存の抽選は★OFFにして対象外にする
    const { data: existing } = await u1.from("lotteries").select("id");
    for (const l of existing ?? []) ok(await setManaged(u1, hid, l.id, false, profA));

    // 応募済み(A)・スルー(B)・対象外(C: 系列ブロック)・枠充足(家族1回: Bのみ)を1つの抽選で作る
    const lot = ok(await saveLottery(u1, hid, null, input({ storeId: store2Id, limitBasis: "family", limitMaxCount: 1 }), profA)).id;
    ok(await setApplied(u1, hid, lot, accA, true, profA));
    ok(await setProfileTargets(u1, hid, { profileId: profC, chainAllow: [], chainBlock: [chainId], storeAllow: [], storeBlock: [] }, profA));
    ok(await addSkipRule(u1, hid, profB, "store", store2Id, profB));
    await job();
    const forLot = sent.filter((s) => s.body.includes("運用電機 支店"));
    expect(forLot).toHaveLength(0); // A=応募済み, B=スルー(かつ枠充足), C=対象外

    // スルーを外しても、1家族1回でAが応募済みなのでBは枠充足 → 通知なし
    const { data: rules } = await u1.from("skip_rules").select("id").eq("profile_id", profB);
    for (const r of rules ?? []) await u1.from("skip_rule_exceptions").delete().eq("skip_rule_id", r.id).then(() => u1.from("skip_rules").delete().eq("id", r.id));
    await job();
    expect(sent.filter((s) => s.body.includes("運用電機 支店"))).toHaveLength(0);

    // 制限が未確認(unknown)の抽選は「要確認」で確定発火しない
    ok(await saveLottery(u1, hid, null, input({ storeId: store2Id, limitBasis: "unknown", memo: "REVIEW" }), profA));
    // 別の応募制限が系列標準にもない → 要確認
    await job();
    expect(sent.filter((s) => s.body.includes("運用電機 支店"))).toHaveLength(0);

    // ★OFFの抽選は応募漏れ通知の対象外（★とスルーは独立）
    const off = ok(await saveLottery(u1, hid, null, input({ storeId: storeId, memo: "OFF" }), profA)).id;
    ok(await setManaged(u1, hid, off, false, profA));
    await job();
    expect(sent.filter((s) => s.body.includes("運用電機 本店"))).toHaveLength(0);

    // 対照: ★ONに戻すと、対象外のC以外（AとB）には届く
    ok(await setManaged(u1, hid, off, true, profA));
    await job();
    expect(recipients("運用電機 本店")).toEqual(["A", "B"]);
  });

  it("定期実行の重複防止: 連続・並行実行でも同じ通知は1回だけ。実行は記録される", async () => {
    await clearDeliveries();
    await clearRuns();
    sent.length = 0;
    await Promise.all([job(), job(), job(), job(), job()]);
    const perDevice = (w: string) => sent.filter((s) => s.endpoint === endpoints[w]).length;
    expect(perDevice("A")).toBe(1);
    expect(perDevice("B")).toBe(1);
    expect(perDevice("C")).toBe(0);
    const before = sent.length;
    await job();
    await job();
    expect(sent.length).toBe(before);

    const { data: runs } = await admin.from("notification_job_runs").select("*").gte("started_at", testStart).order("started_at");
    expect(runs!.length).toBeGreaterThanOrEqual(2);
    expect(runs!.every((r) => ["ok", "running"].includes(r.status))).toBe(true);
    const finished = runs!.filter((r) => r.status === "ok");
    expect(finished.reduce((n, r) => n + (r.sent ?? 0), 0)).toBe(before);
    expect(finished.every((r) => r.duration_ms !== null && r.finished_at !== null)).toBe(true);
  });

  it("実行中の重複起動はスキップされ、異常終了した古い実行は閉じられる", async () => {
    await clearRuns();
    await insertRun({ status: "running", started_at: new Date().toISOString() });
    const skipped = await job();
    expect(skipped.ok && skipped.skipped).toBe(true);

    await clearRuns();
    await insertRun({ status: "running", started_at: new Date(Date.now() - 30 * 60_000).toISOString() });
    const r = await job();
    expect(r.ok && !r.skipped).toBe(true);
    const { data: runs } = await admin.from("notification_job_runs").select("status,error_code").in("id", fixtureIds);
    expect(runs!.some((x) => x.status === "error" && x.error_code === "abandoned")).toBe(true);
  });

  it("送信の失敗は最大3回まで再試行され、送信側が例外を投げてもジョブは止まらない", async () => {
    await clearDeliveries();
    sent.length = 0;
    behavior = "fail";
    for (let i = 0; i < 5; i++) await job();
    const attemptsFor = async () => (await admin.from("notification_deliveries").select("attempts,status").eq("household_id", hid).eq("status", "failed")).data ?? [];
    const failed = await attemptsFor();
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((f) => f.attempts === 3)).toBe(true);
    const callsAfterRetries = sent.length;
    await job();
    expect(sent.length).toBe(callsAfterRetries); // 上限に達した後は再送しない

    await clearDeliveries();
    behavior = "throw";
    const r = await job();
    expect(r.ok && !r.skipped && r.result.failed).toBeGreaterThan(0);
    const { data: rows } = await admin.from("notification_deliveries").select("status,error_code").eq("household_id", hid).eq("status", "failed");
    expect(rows!.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain("secret-detail"); // 例外メッセージは記録しない
    behavior = "ok";
  });

  it("送信中のまま止まった行は10分後に再試行され、直後の行は二重送信されない", async () => {
    await clearDeliveries();
    sent.length = 0;
    await job();
    const first = sent.length;
    expect(first).toBeGreaterThan(0);

    // 直後に「送信中」へ戻しても（別プロセスが処理中とみなし）再送しない
    await admin.from("notification_deliveries").update({ status: "sending" }).eq("household_id", hid).eq("status", "sent");
    await job();
    expect(sent.length).toBe(first);

    // 10分以上たった「送信中」は再試行対象
    await admin.from("notification_deliveries").update({ created_at: new Date(Date.now() - 20 * 60_000).toISOString() }).eq("household_id", hid).eq("status", "sending");
    await job();
    expect(sent.length).toBeGreaterThan(first);
    const { data: rows } = await admin.from("notification_deliveries").select("attempts").eq("household_id", hid).eq("status", "sent");
    expect(rows!.some((r) => r.attempts === 2)).toBe(true);
  });

  it("1回の送信上限を超えた分は次回に回る", async () => {
    await clearDeliveries();
    sent.length = 0;
    const r1 = await job({ maxSends: 1 });
    expect(r1.ok && !r1.skipped && r1.result.sent).toBe(1);
    expect(r1.ok && !r1.skipped && r1.result.deferred).toBeGreaterThan(0);
    const r2 = await job();
    expect(r2.ok && !r2.skipped && r2.result.sent).toBeGreaterThan(0);
  });

  it("ジョブ自体が失敗したら、種別だけを記録する（メッセージ・個人情報は残さない）", async () => {
    await clearRuns();
    const broken = new Proxy(adminDb, {
      get(target, prop) {
        if (prop === "from") {
          return (table: string) =>
            table === "households" ? { select: () => Promise.resolve({ data: null, error: { message: "secret-detail: boom" } }) } : (target as unknown as { from: (t: string) => unknown }).from(table);
        }
        return (target as unknown as Record<string | symbol, unknown>)[prop];
      },
    }) as Db;
    const r = await runNotifyJob(broken, sender, {});
    expect(r.ok).toBe(false);
    const { data: runs } = await admin.from("notification_job_runs").select("*").gte("started_at", testStart);
    expect(runs).toHaveLength(1);
    expect(runs![0]).toMatchObject({ status: "error", error_code: "Error" });
    expect(JSON.stringify(runs)).not.toContain("secret-detail");
  });

  it("起動・スケジュール関数は一般ユーザー・匿名から実行できない。稼働状況は件数なしで参照できる", async () => {
    const anon = anonClient();
    for (const fn of ["invoke_notify_job", "notification_cron_enable", "notification_cron_disable"] as const) {
      expect((await u1.rpc(fn as never)).error, fn).not.toBeNull();
      expect((await anon.rpc(fn as never)).error, fn).not.toBeNull();
    }
    expect((await anon.rpc("notification_job_status")).error).not.toBeNull();
    const st = await u1.rpc("notification_job_status");
    expect(st.error).toBeNull();
    expect(Object.keys((st.data as object[])[0]).sort()).toEqual(["last_run_at", "last_status", "last_success_at", "scheduled"]);
    // 実行記録の表は一般ユーザーから読めない
    for (const t of ["notification_job_runs", "notification_cron_calls"]) {
      const res = await u1.from(t as never).select("*");
      expect(res.error !== null || (res.data ?? []).length === 0, t).toBe(true);
    }
  });

  it("定期実行の起動関数: 未設定なら何も送信せず記録のみ。不正なスケジュールは拒否される", async () => {
    const { data: secrets } = await admin.rpc("invoke_notify_job_config_count" as never);
    void secrets;
    // Vault に URL/秘密が設定済みの環境では、実URLへ送信してしまうためこの確認は行わない
    const { data: cfg } = await adminDb.from("notification_cron_calls").select("id").limit(0);
    void cfg;
    const cfgCount = await (admin as unknown as { schema: (s: string) => { from: (t: string) => { select: (c: string) => Promise<{ data: { name: string }[] | null }> } } })
      .schema("vault")
      .from("decrypted_secrets")
      .select("name")
      .then((r) => r.data?.length ?? -1, () => -1);
    if (cfgCount === 0) {
      const res = await admin.rpc("invoke_notify_job");
      expect(res.error).toBeNull();
      expect(res.data).toBeNull();
      const { data: calls } = await admin.from("notification_cron_calls").select("error_msg,request_id").order("id", { ascending: false }).limit(1);
      expect(calls![0].error_msg).toBe("not_configured");
      expect(calls![0].request_id).toBeNull();
    }
    for (const bad of ["* * * * * *", "*/0 * * * *", "0 0 * * *", "* * * * *; drop table x", "*/61 * * * *"]) {
      expect((await admin.rpc("notification_cron_enable", { p_schedule: bad })).error, bad).not.toBeNull();
    }
    // 検証のみ。スケジュールは登録されていない
    expect((await u1.rpc("notification_job_status")).data).toEqual([expect.objectContaining({ scheduled: false })]);
  });
});
