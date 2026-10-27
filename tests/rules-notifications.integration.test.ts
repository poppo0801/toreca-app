/**
 * Stage 3 の結合テスト（実Supabase・RLS適用下）: スルー・応募ルール・応募対象・資格・通知配信。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { judgeAccount } from "@/lib/eligibility";
import { EMPTY_FLEX, flexToInput } from "@/lib/lottery-input";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { loadAppData, setApplied, setLotterySkip, type Db } from "@/lib/server/lottery-service";
import { runNotificationCycle } from "@/lib/server/notification-service";
import type { PushResult, PushSender } from "@/lib/server/push";
import {
  addSkipRule,
  removeSkipRule,
  setChainRules,
  setLimitExemption,
  setProfileTargets,
  setSkipException,
} from "@/lib/server/rules-service";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const FCM = "https://fcm.googleapis.com/fcm/send/";

describe.skipIf(!dbTestsEnabled)("応募ルール・スルー・資格・通知配信", () => {
  const admin = adminClient();
  const adminDb = admin as unknown as Db;
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  let profA: string;
  let profB: string;
  let profC: string;
  let chainId: string;
  let chain2Id: string;
  let storeA: string;
  let storeB: string;
  let storeC2: string;
  let productId: string;
  let accA: string;
  let accB: string;
  let accC: string;

  const ok = <T,>(r: { ok: boolean; value?: T; error?: string }) => {
    expect(r.ok, r.error).toBe(true);
    return (r as { value: T }).value;
  };
  const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    expect(error).toBeNull();
    return data as { id: string };
  };

  const lotteryInput = (over: Partial<LegacyInput> = {}): LegacyInput => ({
    chainId,
    storeId: storeA,
    campaignId: null,
    newCampaign: null,
    items: [{ productId, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX,
    applyDeadline: EMPTY_FLEX,
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

  beforeAll(async () => {
    const a = await signInTestUser(admin, "p3", 1);
    const b = await signInTestUser(admin, "p3", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    const profiles = (await u1.from("profiles").select("id,label")).data!;
    profA = profiles.find((p) => p.label === "A")!.id;
    profB = profiles.find((p) => p.label === "B")!.id;
    profC = profiles.find((p) => p.label === "C")!.id;

    chainId = (await must(u1.from("chains").insert({ household_id: hid1, name: "P3電機" }).select("id").single())).id;
    chain2Id = (await must(u1.from("chains").insert({ household_id: hid1, name: "P3玩具" }).select("id").single())).id;
    storeA = (await must(u1.from("stores").insert({ household_id: hid1, chain_id: chainId, name: "A店" }).select("id").single())).id;
    storeB = (await must(u1.from("stores").insert({ household_id: hid1, chain_id: chainId, name: "B店" }).select("id").single())).id;
    storeC2 = (await must(u1.from("stores").insert({ household_id: hid1, chain_id: chain2Id, name: "玩具本店" }).select("id").single())).id;
    productId = (await must(u1.from("products").insert({ household_id: hid1, official_name: "P3商品", packs_per_box: 20 }).select("id").single())).id;
    const fam = (await must(u1.from("family_groups").insert({ household_id: hid1, label: "家族" }).select("id").single())).id;
    const adr = (await must(u1.from("address_groups").insert({ household_id: hid1, label: "住所" }).select("id").single())).id;
    const idA = (await must(u1.from("identities").insert({ household_id: hid1, display_label: "名義A", family_group_id: fam, address_group_id: adr }).select("id").single())).id;
    const idB = (await must(u1.from("identities").insert({ household_id: hid1, display_label: "名義B", family_group_id: fam, address_group_id: adr }).select("id").single())).id;
    const acc = (identity: string, profile: string, label: string, chain = chainId) =>
      must(
        u1
          .from("service_accounts")
          .insert({ household_id: hid1, chain_id: chain, identity_id: identity, managed_by_profile_id: profile, account_label: label, membership_state: "eligible" })
          .select("id")
          .single(),
      ).then((r) => r.id);
    accA = await acc(idA, profA, "A-acc");
    accB = await acc(idB, profB, "B-acc");
    accC = await acc(idB, profC, "C-acc");
  });

  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("店舗・系列のスルー、例外解除、解除。スルーは担当プロフィールのみで★とは独立", async () => {
    const lot = ok(await saveLottery(u1, hid1, null, lotteryInput(), profA)).id;
    ok(await addSkipRule(u1, hid1, profA, "store", storeA, profA));
    ok(await addSkipRule(u1, hid1, profA, "store", storeA, profA)); // 冪等
    ok(await addSkipRule(u1, hid1, profA, "chain", chainId, profA));
    let d = await loadAppData(u1);
    expect(d.skipRules.filter((s) => s.profileId === profA && s.scope !== "lottery")).toHaveLength(2);
    expect(d.skipRules.some((s) => s.profileId === profB)).toBe(false);
    const L = d.lotteries.find((l) => l.id === lot)!;
    const accAObj = d.accounts.find((a) => a.id === accA)!;
    const accBObj = d.accounts.find((a) => a.id === accB)!;
    expect(judgeAccount(d, L, accAObj, new Date()).status).toBe("skipped");
    expect(judgeAccount(d, L, accBObj, new Date()).status).not.toBe("skipped");
    expect(d.management.find((m) => m.lotteryId === lot)?.isManaged).toBe(true); // ★は独立

    // 今回だけ例外: 店舗・系列の両方に付く。解除（取り消し）で元に戻る
    ok(await setSkipException(u1, hid1, profA, lot, true, profA));
    d = await loadAppData(u1);
    expect(d.skipRules.filter((s) => s.exceptionLotteryIds.includes(lot))).toHaveLength(2);
    expect(judgeAccount(d, d.lotteries.find((l) => l.id === lot)!, d.accounts.find((a) => a.id === accA)!, new Date()).status).not.toBe("skipped");
    ok(await setSkipException(u1, hid1, profA, lot, false, profA));
    expect((await loadAppData(u1)).skipRules.some((s) => s.exceptionLotteryIds.length > 0)).toBe(false);

    // 抽選単位（今回だけ）もプロフィール別
    ok(await setLotterySkip(u1, hid1, profB, lot, true, profB));
    d = await loadAppData(u1);
    expect(d.skipRules.filter((s) => s.scope === "lottery").map((s) => s.profileId)).toEqual([profB]);

    // 規則の解除（例外つきでも解除できる）
    ok(await setSkipException(u1, hid1, profA, lot, true, profA));
    for (const r of d.skipRules.filter((s) => s.profileId === profA)) ok(await removeSkipRule(u1, r.id));
    d = await loadAppData(u1);
    expect(d.skipRules.filter((s) => s.profileId === profA)).toHaveLength(0);
    ok(await setLotterySkip(u1, hid1, profB, lot, false, profB));
  });

  it("他世帯のスルー・ルールは見えず、操作もできない", async () => {
    ok(await addSkipRule(u1, hid1, profA, "chain", chainId, profA));
    const d2 = await loadAppData(u2);
    expect(d2.skipRules).toHaveLength(0);
    const rule = (await loadAppData(u1)).skipRules[0];
    // 別世帯からの削除は何も起きない（RLS）
    await removeSkipRule(u2, rule.id);
    expect((await loadAppData(u1)).skipRules.some((s) => s.id === rule.id)).toBe(true);
    // 別世帯のプロフィール/店舗を指定した追加は拒否される
    expect((await addSkipRule(u2, hid2, profA, "store", storeA, null)).ok).toBe(false);
    ok(await removeSkipRule(u1, rule.id));
  });

  it("系列の標準応募制限: 置換・重複拒否・読み込み・判定への反映・他世帯非公開", async () => {
    ok(await setChainRules(u1, hid1, chainId, [{ basis: "family", maxCount: 1, across: "lottery", confidence: "confirmed" }, { basis: "person", maxCount: 2, across: "campaign", confidence: "unconfirmed" }], profA));
    let d = await loadAppData(u1);
    expect(d.applicationRules.filter((r) => r.scope === "chain" && r.scopeId === chainId)).toHaveLength(2);

    expect((await setChainRules(u1, hid1, chainId, [{ basis: "person", maxCount: 1, across: "lottery", confidence: "confirmed" }, { basis: "person", maxCount: 2, across: "lottery", confidence: "confirmed" }], profA)).ok).toBe(false);
    expect((await setChainRules(u1, hid1, chainId, [{ basis: "person", maxCount: 0, across: "lottery", confidence: "confirmed" }], profA)).ok).toBe(false);

    // 抽選固有の制限が未設定(unknown)の抽選では、系列標準（1家族1回）が効く
    const lot = ok(await saveLottery(u1, hid1, null, lotteryInput({ storeId: storeB, limitBasis: "unknown" }), profA)).id;
    ok(await setApplied(u1, hid1, lot, accA, true, profA));
    d = await loadAppData(u1);
    const L = d.lotteries.find((l) => l.id === lot)!;
    const rb = judgeAccount(d, L, d.accounts.find((a) => a.id === accB)!, new Date());
    expect(rb.status).toBe("covered_by_limit");
    expect(rb.reason).toContain("系列標準");

    // 置換: ルールを空にすると標準ルールがなくなり「要確認」（応募可能と断定しない）
    ok(await setChainRules(u1, hid1, chainId, [], profA));
    d = await loadAppData(u1);
    expect(d.applicationRules.filter((r) => r.scope === "chain")).toHaveLength(0);
    expect(judgeAccount(d, d.lotteries.find((l) => l.id === lot)!, d.accounts.find((a) => a.id === accB)!, new Date()).status).toBe("needs_review");

    expect((await loadAppData(u2)).applicationRules).toHaveLength(0);
    // 他世帯の系列IDには書けない
    expect((await setChainRules(u2, hid2, chainId, [{ basis: "person", maxCount: 1, across: "lottery", confidence: "confirmed" }], null)).ok).toBe(false);
  });

  it("制限の手動例外: 付与・解除でき、判定に反映される", async () => {
    const lot = ok(await saveLottery(u1, hid1, null, lotteryInput({ storeId: storeB, limitBasis: "family", limitMaxCount: 1 }), profA)).id;
    ok(await setApplied(u1, hid1, lot, accA, true, profA));
    let d = await loadAppData(u1);
    const status = () => judgeAccount(d, d.lotteries.find((l) => l.id === lot)!, d.accounts.find((a) => a.id === accB)!, new Date()).status;
    expect(status()).toBe("covered_by_limit");
    ok(await setLimitExemption(u1, hid1, lot, accB, true, "別世帯として規約確認済み", profB));
    d = await loadAppData(u1);
    expect(d.limitExemptions).toContainEqual({ lotteryId: lot, accountId: accB, reason: "別世帯として規約確認済み" });
    expect(status()).toBe("eligible_unapplied");
    ok(await setLimitExemption(u1, hid1, lot, accB, false, "", profB));
    d = await loadAppData(u1);
    expect(status()).toBe("covered_by_limit");
    // 他世帯からは付与できない
    expect((await setLimitExemption(u2, hid2, lot, accB, true, "", null)).ok).toBe(false);
  });

  it("応募対象（系列・店舗）: 許可リスト/除外の保存・置換・読み込み。矛盾する指定は拒否", async () => {
    ok(await setProfileTargets(u1, hid1, { profileId: profC, chainAllow: [chain2Id], chainBlock: [], storeAllow: [storeA], storeBlock: [] }, profA));
    let d = await loadAppData(u1);
    let c = d.profiles.find((p) => p.id === profC)!;
    expect(c.allowedChainIds).toEqual([chain2Id]);
    expect(c.allowedStoreIds).toEqual([storeA]);

    ok(await setProfileTargets(u1, hid1, { profileId: profC, chainAllow: [], chainBlock: [chain2Id], storeAllow: [], storeBlock: [storeB] }, profA));
    d = await loadAppData(u1);
    c = d.profiles.find((p) => p.id === profC)!;
    expect(c.allowedChainIds).toBeNull();
    expect(c.blockedChainIds).toEqual([chain2Id]);
    expect(c.blockedStoreIds).toEqual([storeB]);
    expect(c.allowedStoreIds).toEqual([]);

    expect((await setProfileTargets(u1, hid1, { profileId: profC, chainAllow: [chainId], chainBlock: [chainId], storeAllow: [], storeBlock: [] }, profA)).ok).toBe(false);
    // 店舗の系列は店舗から導出される（不整合な組み合わせは作れない）。他世帯の店舗は不可
    expect((await setProfileTargets(u2, hid2, { profileId: profC, chainAllow: [], chainBlock: [], storeAllow: [storeA], storeBlock: [] }, null)).ok).toBe(false);
    const direct = await u1.from("profile_target_rules").insert({ household_id: hid1, profile_id: profC, chain_id: chainId, store_id: storeC2, mode: "allow" });
    expect(direct.error).not.toBeNull(); // 店舗(玩具本店)は系列(P3電機)に属さない → 複合FKで拒否

    ok(await setProfileTargets(u1, hid1, { profileId: profC, chainAllow: [], chainBlock: [], storeAllow: [], storeBlock: [] }, profA));
    expect((await loadAppData(u1)).profiles.find((p) => p.id === profC)!.blockedChainIds).toEqual([]);
  });

  it("応募資格: 条件・アカウント別の資格・購入実績。系列不一致は拒否され、判定に反映（不明・期限切れは要確認）", async () => {
    const req = await must(u1.from("chain_requirements").insert({ household_id: hid1, chain_id: chainId, kind: "membership", label: "会員登録", valid_months: 12 }).select("id").single());
    const reqOther = await must(u1.from("chain_requirements").insert({ household_id: hid1, chain_id: chain2Id, kind: "point_card", label: "ポイントカード" }).select("id").single());

    // 別系列の条件は紐づけられない（複合FK）
    const mismatch = await u1.from("account_eligibilities").insert({ household_id: hid1, chain_id: chainId, service_account_id: accA, requirement_id: reqOther.id, state: "eligible" });
    expect(mismatch.error).not.toBeNull();

    const today = new Date();
    const ymd = (offsetDays: number) => new Date(today.getTime() + offsetDays * 86400_000).toISOString().slice(0, 10);
    await must(u1.from("account_eligibilities").insert({ household_id: hid1, chain_id: chainId, service_account_id: accA, requirement_id: req.id, state: "eligible", valid_until: ymd(30) }).select("id").single());
    await must(u1.from("account_eligibilities").insert({ household_id: hid1, chain_id: chainId, service_account_id: accB, requirement_id: req.id, state: "eligible", valid_until: ymd(-5) }).select("id").single());
    // 購入実績（日付・金額は不明を許す）
    await must(u1.from("eligibility_purchases").insert({ household_id: hid1, service_account_id: accA, store_id: storeA, amount_yen: null, purchased_on: null, counts_until: ymd(60) }).select("id").single());

    const lot = ok(await saveLottery(u1, hid1, null, lotteryInput({ storeId: storeB, limitBasis: "account" }), profA)).id;
    const d = await loadAppData(u1);
    const L = d.lotteries.find((l) => l.id === lot)!;
    const st = (id: string) => judgeAccount(d, L, d.accounts.find((a) => a.id === id)!, today);
    expect(st(accA).status).toBe("eligible_unapplied");
    expect(st(accB)).toMatchObject({ status: "needs_review", reason: expect.stringContaining("有効期限切れ") });
    expect(st(accC).status).toBe("needs_review"); // 資格未登録
    expect(d.eligibilities).toHaveLength(2);

    // 他世帯は読めない。資格行の物理削除はできない（アーカイブ）
    expect((await u2.from("account_eligibilities").select("id")).data).toHaveLength(0);
    const del = await u1.from("account_eligibilities").delete().eq("requirement_id", req.id).select();
    expect(del.error !== null || (del.data ?? []).length === 0).toBe(true);
    await u1.from("chain_requirements").update({ archived_at: new Date().toISOString() }).eq("id", reqOther.id);
    expect((await loadAppData(u1)).requirements.some((r) => r.id === reqOther.id)).toBe(false);
  });

  // ------------------------------------------------------------ Web Push 購読
  it("購読はRPC経由のみ: 鍵は直接読めず、端末はプロフィールへ紐づき、付け替えで旧紐付けが解除される", async () => {
    const endpoint = `${FCM}test-${crypto.randomUUID()}`;
    expect((await u1.rpc("register_push_subscription", { p_endpoint: endpoint, p_p256dh: "p".repeat(20), p_auth: "a".repeat(16), p_profile: profA, p_label: "テスト端末" })).error).toBeNull();

    // 鍵・endpoint を含む表は直接読めない
    const direct = await u1.from("push_subscriptions" as never).select("*");
    expect(direct.error !== null || (direct.data ?? []).length === 0).toBe(true);
    expect((await anonClient().rpc("push_subscription_status", { p_endpoint: endpoint })).error).not.toBeNull();

    let st = (await u1.rpc("push_subscription_status", { p_endpoint: endpoint })).data as { profile_id: string; enabled: boolean }[];
    expect(st).toEqual([{ profile_id: profA, enabled: true }]);

    // 切替: 同じ端末の通知先がBに変わり、Aには届かない
    expect((await u1.rpc("rebind_push_subscription", { p_endpoint: endpoint, p_profile: profB })).data).toBe(true);
    st = (await u1.rpc("push_subscription_status", { p_endpoint: endpoint })).data as { profile_id: string; enabled: boolean }[];
    expect(st[0].profile_id).toBe(profB);
    const { data: subs } = await admin.from("push_subscriptions").select("profile_id").eq("endpoint", endpoint);
    expect(subs).toEqual([{ profile_id: profB }]);

    // 他世帯からは見えず、付け替え・削除・横取り登録もできない
    expect(((await u2.rpc("push_subscription_status", { p_endpoint: endpoint })).data as unknown[]).length).toBe(0);
    expect((await u2.rpc("rebind_push_subscription", { p_endpoint: endpoint, p_profile: profA })).error).not.toBeNull();
    expect((await u2.rpc("register_push_subscription", { p_endpoint: endpoint, p_p256dh: "p".repeat(20), p_auth: "a".repeat(16), p_profile: (await u2.from("profiles").select("id").limit(1).single()).data!.id, p_label: "" })).error).not.toBeNull();
    await u2.rpc("remove_push_subscription", { p_endpoint: endpoint });
    expect((await admin.from("push_subscriptions").select("id").eq("endpoint", endpoint)).data).toHaveLength(1);

    // 自世帯のプロフィール以外へは紐づけられない
    const otherProfile = (await u2.from("profiles").select("id").limit(1).single()).data!.id;
    expect((await u1.rpc("rebind_push_subscription", { p_endpoint: endpoint, p_profile: otherProfile })).error).not.toBeNull();
    // httpのendpointは拒否（DB制約）
    expect((await u1.rpc("register_push_subscription", { p_endpoint: "http://insecure.example/x", p_p256dh: "p".repeat(20), p_auth: "a".repeat(16), p_profile: profA, p_label: "" })).error).not.toBeNull();

    await u1.rpc("remove_push_subscription", { p_endpoint: endpoint });
    expect((await admin.from("push_subscriptions").select("id").eq("endpoint", endpoint)).data).toHaveLength(0);
  });

  it("通知設定はプロフィール別に保存でき、他世帯からは見えない。配信履歴はクライアントから書けない", async () => {
    const up = await u1.from("notification_settings").upsert({ household_id: hid1, profile_id: profA, morning_time: "08:30", deadline_offsets_min: [60], date_only_policy: "none" }, { onConflict: "profile_id" });
    expect(up.error).toBeNull();
    const row = (await u1.from("notification_settings").select("*").eq("profile_id", profA).single()).data!;
    expect(row).toMatchObject({ morning_time: "08:30:00", deadline_offsets_min: [60], date_only_policy: "none", enabled: true });
    expect((await u2.from("notification_settings").select("*")).data).toHaveLength(0);
    expect((await u1.from("notification_settings").insert({ household_id: hid1, profile_id: profB, date_only_policy: "weird" })).error).not.toBeNull();

    const forged = await u1.from("notification_deliveries").insert({ household_id: hid1, profile_id: profA, trigger_key: "x", type: "x", status: "sent" });
    expect(forged.error).not.toBeNull();
    await u1.from("notification_settings").delete().eq("profile_id", profA);
    expect((await u1.from("notification_settings").select("id").eq("profile_id", profA)).data).toHaveLength(1);
    await u1.from("notification_settings").update({ morning_time: "09:00", deadline_offsets_min: [120, 15], date_only_policy: "morning_of" }).eq("profile_id", profA);
  });

  // ------------------------------------------------------------ 通知ジョブ（配信・重複防止）
  describe("通知ジョブ", () => {
    const calls: { endpoint: string; title: string }[] = [];
    let mode: "ok" | "fail" | "gone" = "ok";
    const sender: PushSender = async (sub, payload): Promise<PushResult> => {
      calls.push({ endpoint: sub.endpoint, title: payload.title });
      if (mode === "ok") return { ok: true };
      return mode === "gone" ? { ok: false, gone: true, status: 410 } : { ok: false, gone: false, status: 500 };
    };
    let endpointA: string;
    let lotId: string;

    beforeAll(async () => {
      endpointA = `${FCM}job-${crypto.randomUUID()}`;
      ok(
        (await u1.rpc("register_push_subscription", { p_endpoint: endpointA, p_p256dh: "p".repeat(20), p_auth: "a".repeat(16), p_profile: profA, p_label: "A端末" })).error === null
          ? { ok: true, value: undefined }
          : { ok: false, error: "register failed" },
      );
      const deadline = flexToInput({ precision: "date_time", at: new Date(Date.now() + 10 * 60_000).toISOString() });
      lotId = ok(await saveLottery(u1, hid1, null, lotteryInput({ storeId: storeB, applyDeadline: deadline, limitBasis: "account" }), profA)).id;
    });

    const deliveries = async () =>
      (await admin.from("notification_deliveries").select("trigger_key,status,attempts,profile_id").eq("household_id", hid1).eq("lottery_id", lotId)).data ?? [];

    it("担当プロフィールの端末にだけ送られ、手前の段階は抑止される。再実行しても二重配信されない", async () => {
      calls.length = 0;
      const r1 = await runNotificationCycle(adminDb, sender, new Date(), hid1);
      // A・B・Cのうち、端末があるのはAのみ（Bの分は端末なしで見送り）
      expect(r1.sent).toBe(1);
      expect(calls.filter((c) => c.endpoint === endpointA)).toHaveLength(1);
      const rows = await deliveries();
      expect(rows.filter((x) => x.status === "sent")).toHaveLength(1);
      expect(rows.filter((x) => x.status === "suppressed").length).toBeGreaterThanOrEqual(1); // 2時間前・朝などの手前の段階
      expect(rows.every((x) => x.profile_id === profA)).toBe(true);

      const r2 = await runNotificationCycle(adminDb, sender, new Date(), hid1);
      expect(r2.sent).toBe(0);
      expect(r2.duplicates).toBeGreaterThanOrEqual(1);
      expect(calls.filter((c) => c.endpoint === endpointA)).toHaveLength(1); // 追加送信なし

      // 並行実行でも1回だけ（先に配信権を確保する）
      await admin.from("notification_deliveries").delete().eq("household_id", hid1).eq("lottery_id", lotId);
      calls.length = 0;
      await Promise.all([runNotificationCycle(adminDb, sender, new Date(), hid1), runNotificationCycle(adminDb, sender, new Date(), hid1)]);
      expect(calls.filter((c) => c.endpoint === endpointA)).toHaveLength(1);
    });

    it("応募済みになった抽選は通知されない（配信直前の再評価）", async () => {
      await admin.from("notification_deliveries").delete().eq("household_id", hid1).eq("lottery_id", lotId);
      ok(await setApplied(u1, hid1, lotId, accA, true, profA));
      calls.length = 0;
      const r = await runNotificationCycle(adminDb, sender, new Date(), hid1);
      expect(r.sent).toBe(0);
      expect(calls).toHaveLength(0);
      expect((await deliveries()).filter((x) => x.status === "sent")).toHaveLength(0);
      ok(await setApplied(u1, hid1, lotId, accA, false, profA));
    });

    it("失敗は最大3回まで再試行し、購読失効(410)の端末は無効化される", async () => {
      await admin.from("notification_deliveries").delete().eq("household_id", hid1).eq("lottery_id", lotId);
      mode = "fail";
      for (let i = 0; i < 4; i++) await runNotificationCycle(adminDb, sender, new Date(), hid1);
      const failed = (await deliveries()).find((x) => x.status === "failed")!;
      expect(failed.attempts).toBe(3); // 4回目は再試行しない
      mode = "ok";

      await admin.from("notification_deliveries").delete().eq("household_id", hid1).eq("lottery_id", lotId);
      mode = "gone";
      await runNotificationCycle(adminDb, sender, new Date(), hid1);
      const sub = (await admin.from("push_subscriptions").select("enabled").eq("endpoint", endpointA).single()).data!;
      expect(sub.enabled).toBe(false);
      mode = "ok";
    });
  });
});
