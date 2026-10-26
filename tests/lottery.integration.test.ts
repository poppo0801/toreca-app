/**
 * 抽選まわりの結合テスト（実Supabase・RLS適用下）。通常の `npm test` では実行されない:
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import {
  addManualPurchase,
  archiveLottery,
  currentHouseholdId,
  duplicateLottery,
  loadAppData,
  saveLottery,
  setApplied,
  setEventState,
  setFulfillment,
  setLotterySkip,
  setManaged,
  setResult,
  type Db,
} from "@/lib/server/lottery-service";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("抽選・応募・購入の保存と世帯分離", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  let profA: string;
  let profB: string;
  let chainId: string;
  let storeA: string;
  let storeB: string;
  let productId: string;
  let accA: string;
  let accB: string;

  const ok = <T,>(r: { ok: boolean; value?: T; error?: string }) => {
    expect(r.ok, r.error).toBe(true);
    return (r as { value: T }).value;
  };

  const base = (over: Partial<LotteryInput> = {}): LotteryInput => ({
    chainId,
    storeId: storeA,
    campaignId: null,
    newCampaign: null,
    items: [{ productId, quantity: 2, unit: "box" }],
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
    const a = await signInTestUser(admin, "lot", 1);
    const b = await signInTestUser(admin, "lot", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    expect(await currentHouseholdId(u1)).toBe(hid1);

    const profiles = (await u1.from("profiles").select("id,label")).data!;
    profA = profiles.find((p) => p.label === "A")!.id;
    profB = profiles.find((p) => p.label === "B")!.id;

    const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
      const { data, error } = await p;
      expect(error).toBeNull();
      return data as { id: string };
    };
    chainId = (await must(u1.from("chains").insert({ household_id: hid1, name: "結合テスト電機" }).select("id").single())).id;
    storeA = (await must(u1.from("stores").insert({ household_id: hid1, chain_id: chainId, name: "A店" }).select("id").single())).id;
    storeB = (await must(u1.from("stores").insert({ household_id: hid1, chain_id: chainId, name: "B店" }).select("id").single())).id;
    productId = (await must(u1.from("products").insert({ household_id: hid1, official_name: "テスト商品", packs_per_box: 20 }).select("id").single())).id;
    const fam = (await must(u1.from("family_groups").insert({ household_id: hid1, label: "家族" }).select("id").single())).id;
    const adr = (await must(u1.from("address_groups").insert({ household_id: hid1, label: "住所" }).select("id").single())).id;
    const idA = (await must(u1.from("identities").insert({ household_id: hid1, display_label: "名義A", family_group_id: fam, address_group_id: adr }).select("id").single())).id;
    const idB = (await must(u1.from("identities").insert({ household_id: hid1, display_label: "名義B", family_group_id: fam, address_group_id: adr }).select("id").single())).id;
    accA = (await must(u1.from("service_accounts").insert({ household_id: hid1, chain_id: chainId, identity_id: idA, managed_by_profile_id: profA, account_label: "A-acc", membership_state: "eligible" }).select("id").single())).id;
    accB = (await must(u1.from("service_accounts").insert({ household_id: hid1, chain_id: chainId, identity_id: idB, managed_by_profile_id: profB, account_label: "B-acc", membership_state: "eligible" }).select("id").single())).id;
  });

  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  let pastId: string;

  it("締切済みの過去抽選を、応募済み・当選まで同時登録できる（日時不明は不明のまま保存）", async () => {
    const res = await saveLottery(
      u1,
      hid1,
      null,
      base({
        applyDeadline: { precision: "date_time", date: "2026-01-10", time: "23:59" },
        resultDate: { precision: "date_only", date: "2026-01-15", time: "" },
        applications: [
          { accountId: accA, status: "applied" },
          { accountId: accB, status: "won" },
        ],
      }),
      profA,
    );
    pastId = ok(res).id;

    const { data: row } = await u1.from("lotteries").select("*").eq("id", pastId).single();
    expect(row).toMatchObject({
      apply_deadline_precision: "date_time",
      result_precision: "date_only",
      result_date: "2026-01-15",
      result_at: null,
      apply_start_precision: "unknown",
      apply_start_date: null,
      apply_start_at: null,
      procedure_deadline_precision: "unknown",
    });
    expect(row!.apply_deadline_at).toBe("2026-01-10T14:59:00+00:00"); // JST 23:59

    const data = await loadAppData(u1);
    const lot = data.lotteries.find((l) => l.id === pastId)!;
    expect(lot.applyDeadline).toEqual({ precision: "date_time", at: "2026-01-10T14:59:00+00:00" });
    expect(lot.resultDate).toEqual({ precision: "date_only", date: "2026-01-15" });
    expect(lot.applyStart).toEqual({ precision: "unknown" });
    expect(data.management.find((m) => m.lotteryId === pastId)?.isManaged).toBe(true);
    const apps = data.applications.filter((a) => a.lotteryId === pastId);
    expect(apps.map((a) => a.result).sort()).toEqual(["pending", "won"]);
    expect(apps.every((a) => a.appliedAt === null)).toBe(true); // 実際の応募日時は不明のまま
  });

  it("不正な入力は拒否される（別系列の店舗・日付不備・他系列のアカウント）", async () => {
    const otherChain = (await u1.from("chains").insert({ household_id: hid1, name: "別系列" }).select("id").single()).data!.id;
    expect((await saveLottery(u1, hid1, null, base({ chainId: otherChain }), profA)).ok).toBe(false);
    expect(
      (await saveLottery(u1, hid1, null, base({ applyDeadline: { precision: "date_only", date: "", time: "" } }), profA)).ok,
    ).toBe(false);
    expect((await saveLottery(u1, hid1, null, base({ items: [] }), profA)).ok).toBe(false);
    expect((await saveLottery(u1, hid1, null, base({ applications: [{ accountId: crypto.randomUUID(), status: "applied" }] }), profA)).ok).toBe(false);
    // 失敗した新規登録は一覧に残らない
    const data = await loadAppData(u1);
    expect(data.lotteries.filter((l) => l.chainId === otherChain)).toHaveLength(0);
  });

  it("編集: 商品明細が置換され、応募・当落には触れない", async () => {
    ok(await saveLottery(u1, hid1, pastId, base({ items: [{ productId, quantity: 3, unit: "pack" }], memo: "編集済み" }), profA));
    const data = await loadAppData(u1);
    const lot = data.lotteries.find((l) => l.id === pastId)!;
    expect(lot.items).toEqual([{ productId, quantity: 3, unit: "pack" }]);
    expect(lot.memo).toBe("編集済み");
    expect(data.applications.filter((a) => a.lotteryId === pastId)).toHaveLength(2);
  });

  it("購入済みを繰り返しても購入記録は1件。当選以外・購入後の結果変更は拒否される", async () => {
    const data = await loadAppData(u1);
    const won = data.applications.find((a) => a.lotteryId === pastId && a.result === "won")!;
    const pending = data.applications.find((a) => a.lotteryId === pastId && a.result === "pending")!;

    ok(await setFulfillment(u1, won.id, "purchased", profB));
    ok(await setFulfillment(u1, won.id, "purchased", profB));
    ok(await setFulfillment(u1, won.id, "purchased", profB));
    const after = await loadAppData(u1);
    const purchases = after.purchases.filter((p) => p.applicationId === won.id);
    expect(purchases).toHaveLength(1);
    expect(purchases[0].items).toEqual([{ productId, quantity: 3, unit: "pack", amountPaid: null }]);
    expect(purchases[0].source).toBe("lottery");
    expect(after.applications.find((a) => a.id === won.id)?.fulfillment).toBe("purchased");

    // 未当選の応募は購入済みにできない
    expect((await setFulfillment(u1, pending.id, "purchased", profB)).ok).toBe(false);
    // 購入済みの応募の結果は変更できない（履歴の整合）
    const r = await setResult(u1, won.id, "lost", profB);
    expect(r.ok).toBe(false);
    expect(after.applications.find((a) => a.id === won.id)?.result).toBe("won");
  });

  it("当落の記録: 結果確認日時が付き、未確認に戻すと消える。応募取消しても行は残る", async () => {
    const data = await loadAppData(u1);
    const pending = data.applications.find((a) => a.lotteryId === pastId && a.result === "pending")!;
    ok(await setResult(u1, pending.id, "lost", profA));
    let d = await loadAppData(u1);
    expect(d.applications.find((a) => a.id === pending.id)).toMatchObject({ result: "lost" });
    expect(d.applications.find((a) => a.id === pending.id)?.resultConfirmedAt).not.toBeNull();
    ok(await setResult(u1, pending.id, "pending", profA));
    d = await loadAppData(u1);
    expect(d.applications.find((a) => a.id === pending.id)?.resultConfirmedAt).toBeNull();

    // 応募の記録/取消: 一意（抽選×アカウント）で行は増えない
    const l2 = ok(await saveLottery(u1, hid1, null, base({ storeId: storeB }), profA)).id;
    ok(await setApplied(u1, hid1, l2, accA, true, profA));
    ok(await setApplied(u1, hid1, l2, accA, true, profA));
    ok(await setApplied(u1, hid1, l2, accA, false, profA));
    ok(await setApplied(u1, hid1, l2, accA, true, profA));
    d = await loadAppData(u1);
    const rows = d.applications.filter((a) => a.lotteryId === l2 && a.accountId === accA);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("applied");
    expect(rows[0].appliedAt).not.toBeNull(); // 画面から記録した応募は日時あり
  });

  it("★OFFでも応募・購入履歴は消えない。スルーは実行プロフィールのみ", async () => {
    ok(await setManaged(u1, hid1, pastId, false, profA));
    let d = await loadAppData(u1);
    expect(d.management.find((m) => m.lotteryId === pastId)?.isManaged).toBe(false);
    expect(d.applications.filter((a) => a.lotteryId === pastId)).toHaveLength(2);
    expect(d.purchases.some((p) => p.applicationId !== null)).toBe(true);
    ok(await setManaged(u1, hid1, pastId, true, profA));

    ok(await setLotterySkip(u1, hid1, profA, pastId, true, profA));
    ok(await setLotterySkip(u1, hid1, profA, pastId, true, profA)); // 冪等
    d = await loadAppData(u1);
    const skips = d.skipRules.filter((s) => s.scope === "lottery" && s.scopeId === pastId);
    expect(skips.map((s) => s.profileId)).toEqual([profA]);
    ok(await setLotterySkip(u1, hid1, profA, pastId, false, profA));
    expect((await loadAppData(u1)).skipRules.filter((s) => s.scopeId === pastId)).toHaveLength(0);
  });

  it("中止・発表延期は抽選の状態として記録される（個別の当落とは別）", async () => {
    ok(await setEventState(u1, pastId, "postponed", profA));
    expect((await loadAppData(u1)).lotteries.find((l) => l.id === pastId)?.eventState).toBe("postponed");
    ok(await setEventState(u1, pastId, "cancelled", profA));
    expect((await loadAppData(u1)).lotteries.find((l) => l.id === pastId)?.eventState).toBe("cancelled");
    ok(await setEventState(u1, pastId, "open", profA));
  });

  it("他店舗への複製: 店舗ごとに独立して作られ、同じキャンペーンに属し、応募は複製されない", async () => {
    const src = ok(await saveLottery(u1, hid1, null, base({ newCampaign: { name: "結合テストCP", storeRule: "one_store" }, applications: [{ accountId: accA, status: "applied" }] }), profA)).id;
    const { ids } = ok(await duplicateLottery(u1, hid1, src, [storeB], profA));
    expect(ids).toHaveLength(1);
    const d = await loadAppData(u1);
    const original = d.lotteries.find((l) => l.id === src)!;
    const copy = d.lotteries.find((l) => l.id === ids[0])!;
    expect(copy.storeId).toBe(storeB);
    expect(copy.campaignId).toBe(original.campaignId);
    expect(d.campaigns.find((c) => c.id === copy.campaignId)?.storeRule).toBe("one_store");
    expect(copy.items).toEqual(original.items);
    expect(d.applications.filter((a) => a.lotteryId === copy.id)).toHaveLength(0);
    expect(d.management.find((m) => m.lotteryId === copy.id)?.isManaged).toBe(true);
    // 別系列の店舗は不可
    const otherChain = (await u1.from("chains").insert({ household_id: hid1, name: "複製用別系列" }).select("id").single()).data!.id;
    const foreignStore = (await u1.from("stores").insert({ household_id: hid1, chain_id: otherChain, name: "別店" }).select("id").single()).data!.id;
    expect((await duplicateLottery(u1, hid1, src, [foreignStore], profA)).ok).toBe(false);
  });

  it("取り下げ(アーカイブ)しても行・応募・購入は残り、一覧から外れる。物理削除はできない", async () => {
    const id = ok(await saveLottery(u1, hid1, null, base({ applications: [{ accountId: accA, status: "applied" }] }), profA)).id;
    ok(await archiveLottery(u1, id, profA));
    const d = await loadAppData(u1);
    expect(d.lotteries.some((l) => l.id === id)).toBe(false);
    expect(d.applications.some((a) => a.lotteryId === id)).toBe(false);
    const { data: still } = await u1.from("lotteries").select("id,archived_at").eq("id", id).single();
    expect(still?.archived_at).not.toBeNull();
    expect((await u1.from("applications").select("id").eq("lottery_id", id)).data).toHaveLength(1);

    const del = await u1.from("lotteries").delete().eq("id", id).select();
    expect(del.error !== null || (del.data ?? []).length === 0).toBe(true);
    const delApp = await u1.from("applications").delete().eq("lottery_id", id).select();
    expect(delApp.error !== null || (delApp.data ?? []).length === 0).toBe(true);
    const delPur = await u1.from("purchases").delete().neq("id", crypto.randomUUID()).select();
    expect(delPur.error !== null || (delPur.data ?? []).length === 0).toBe(true);
  });

  it("抽選外の購入: 日時・金額が不明でも保存でき、不明を0円や仮の日時にしない", async () => {
    const unknown = ok(await addManualPurchase(u1, hid1, { storeId: "", date: "", time: "", channel: "store", note: "", items: [{ productId: "", quantity: 1, unit: "box", amountPaid: null }] }, profA)).id;
    const dateOnly = ok(await addManualPurchase(u1, hid1, { storeId: storeA, date: "2026-02-03", time: "", channel: "online", note: "メモ", items: [{ productId, quantity: 2, unit: "box", amountPaid: 0 }] }, profA)).id;
    const d = await loadAppData(u1);
    const pu = d.purchases.find((p) => p.id === unknown)!;
    expect(pu.purchasedOn).toEqual({ precision: "unknown" });
    expect(pu.items[0]).toMatchObject({ productId: null, amountPaid: null });
    expect(pu.applicationId).toBeNull();
    const pd = d.purchases.find((p) => p.id === dateOnly)!;
    expect(pd.purchasedOn).toEqual({ precision: "date_only", date: "2026-02-03" });
    expect(pd.items[0].amountPaid).toBe(0); // 0円は0円として保存（不明とは別）
    expect((await addManualPurchase(u1, hid1, { storeId: "", date: "", time: "10:00", channel: "store", note: "", items: [{ productId: "", quantity: 1, unit: "box", amountPaid: null }] }, profA)).ok).toBe(false);
    expect((await addManualPurchase(u1, hid1, { storeId: "", date: "", time: "", channel: "store", note: "", items: [] }, profA)).ok).toBe(false);
  });

  it("DB制約: 未当選の応募に購入状態は付けられない／日付精度の不整合は拒否される", async () => {
    const d = await loadAppData(u1);
    const pending = d.applications.find((a) => a.result === "pending")!;
    const bad = await u1.from("applications").update({ fulfillment_status: "purchased" }).eq("id", pending.id);
    expect(bad.error).not.toBeNull();
    const badDate = await u1.from("lotteries").update({ apply_deadline_precision: "date_time", apply_deadline_at: null }).eq("id", pastId);
    expect(badDate.error).not.toBeNull();
  });

  it("別世帯からは読めず・操作できず・購入関数も使えない", async () => {
    const d2 = await loadAppData(u2);
    expect(d2.lotteries).toHaveLength(0);
    expect(d2.applications).toHaveLength(0);
    expect(d2.purchases).toHaveLength(0);
    expect(d2.chains).toHaveLength(0);

    // u1 の系列・店舗を使った登録は拒否される
    expect((await saveLottery(u2, hid2, null, base(), crypto.randomUUID())).ok).toBe(false);
    expect((await saveLottery(u2, hid2, pastId, base(), null)).ok).toBe(false);

    const d1 = await loadAppData(u1);
    const won = d1.applications.find((a) => a.result === "won")!;
    expect((await setFulfillment(u2, won.id, "purchased", null)).ok).toBe(false);
    expect((await setResult(u2, won.id, "lost", null)).ok).toBe(false);
    expect((await setManaged(u2, hid2, pastId, false, null)).ok).toBe(false);
    // 他世帯IDを偽装した書き込みも拒否（RLS with check）
    const forged = await u2.from("lotteries").insert({ household_id: hid1, chain_id: chainId, store_id: storeA });
    expect(forged.error).not.toBeNull();
    // 変更されていない
    expect((await loadAppData(u1)).applications.find((a) => a.id === won.id)?.result).toBe("won");
  });

  it("操作は監査ログに前後の値付きで残る（実行プロフィール付き）", async () => {
    const d = await loadAppData(u1);
    const logs = d.audit.filter((a) => a.entityType === "applications");
    expect(logs.length).toBeGreaterThan(0);
    const fulfil = logs.find((l) => (l.after as { fulfillment_status?: string } | null)?.fulfillment_status === "purchased");
    expect(fulfil?.actorProfileId).toBe(profB);
    expect((fulfil?.before as { fulfillment_status?: string }).fulfillment_status).toBe("none");
  });

  it("匿名ではどのテーブルも読めない", async () => {
    const anon = anonClient();
    for (const t of ["lotteries", "applications", "purchases", "purchase_items", "skip_rules", "campaigns", "lottery_items", "lottery_management"]) {
      const { data, error } = await anon.from(t).select("*");
      expect(error !== null || (data ?? []).length === 0, t).toBe(true);
    }
    expect((await anon.rpc("mark_purchased", { p_application_id: crypto.randomUUID(), p_actor: crypto.randomUUID() })).error).not.toBeNull();
  });
});
