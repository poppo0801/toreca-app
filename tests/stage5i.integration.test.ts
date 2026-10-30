/**
 * Stage 5I の結合テスト（実Supabase・RLS適用下）。通常の `npm test` では実行されない:
 *   npm run test:db
 * 他のプロフィールの応募状態を変えられないこと（サーバー側の確認）、当落発表の期間の保存・制約・互換性。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { duplicateLottery, loadAppData, setApplied, type Db } from "@/lib/server/lottery-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 5I: 応募操作の権限と発表期間", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
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
  const base = (over: Partial<LegacyInput> = {}): LegacyInput => ({
    chainId,
    storeId: storeA,
    campaignId: null,
    newCampaign: null,
    items: [{ productId, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX,
    applyDeadline: { precision: "date_time", date: "2099-01-10", time: "23:59" },
    resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX,
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
    limitMaxCount: 5,
    memo: "",
    applications: [],
    appliedAt: "",
    ...over,
  });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5i", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    const profiles = (await u1.from("profiles").select("id,label")).data!;
    profA = profiles.find((p) => p.label === "A")!.id;
    profB = profiles.find((p) => p.label === "B")!.id;
    const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
      const { data, error } = await p;
      expect(error).toBeNull();
      return data as { id: string };
    };
    chainId = (await must(u1.from("chains").insert({ household_id: hid, name: "5I電機" }).select("id").single())).id;
    storeA = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "5I-A店" }).select("id").single())).id;
    storeB = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "5I-B店" }).select("id").single())).id;
    productId = (await must(u1.from("products").insert({ household_id: hid, official_name: "5I商品", packs_per_box: 20 }).select("id").single())).id;
    const fam = (await must(u1.from("family_groups").insert({ household_id: hid, label: "家族" }).select("id").single())).id;
    const adr = (await must(u1.from("address_groups").insert({ household_id: hid, label: "住所" }).select("id").single())).id;
    const idA = (await must(u1.from("identities").insert({ household_id: hid, display_label: "名義A", family_group_id: fam, address_group_id: adr }).select("id").single())).id;
    const idB = (await must(u1.from("identities").insert({ household_id: hid, display_label: "名義B", family_group_id: fam, address_group_id: adr }).select("id").single())).id;
    accA = (await must(u1.from("service_accounts").insert({ household_id: hid, chain_id: chainId, identity_id: idA, managed_by_profile_id: profA, account_label: "A-acc", membership_state: "eligible" }).select("id").single())).id;
    accB = (await must(u1.from("service_accounts").insert({ household_id: hid, chain_id: chainId, identity_id: idB, managed_by_profile_id: profB, account_label: "B-acc", membership_state: "eligible" }).select("id").single())).id;
  });

  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("サーバー側でも、自分のプロフィールのアカウントしか応募状態を変えられない（他のプロフィールは拒否）", async () => {
    const id = ok(await saveLottery(u1, hid, null, base(), profA)).id;
    // AがBのアカウントを応募済みにしようとしても拒否され、記録は作られない
    const denied = await setApplied(u1, hid, id, accB, true, profA);
    expect(denied.ok).toBe(false);
    let d = await loadAppData(u1);
    expect(d.applications.filter((a) => a.lotteryId === id)).toHaveLength(0);
    // 自分のアカウントは操作できる
    ok(await setApplied(u1, hid, id, accA, true, profA));
    // BのアカウントはBだけが操作できる。AはBの応募を取り消せない
    ok(await setApplied(u1, hid, id, accB, true, profB));
    const cancelByA = await setApplied(u1, hid, id, accB, false, profA);
    expect(cancelByA.ok).toBe(false);
    d = await loadAppData(u1);
    expect(d.applications.find((a) => a.lotteryId === id && a.accountId === accB)?.state).toBe("applied");
    // 解除は本人が行える。Aの応募は変わらない
    ok(await setApplied(u1, hid, id, accB, false, profB));
    d = await loadAppData(u1);
    expect(d.applications.find((a) => a.lotteryId === id && a.accountId === accB)?.state).toBe("cancelled");
    expect(d.applications.find((a) => a.lotteryId === id && a.accountId === accA)?.state).toBe("applied");
  });

  it("当落発表の期間: 開始（時刻つきも可）と最終日を保存して読める。単一日は最終日なしのまま", async () => {
    const single = ok(await saveLottery(u1, hid, null, base({ resultDate: { precision: "date_only", date: "2099-02-01", time: "" } }), profA)).id;
    const range = ok(await saveLottery(u1, hid, null, base({ resultDate: { precision: "date_only", date: "2099-02-07", time: "" }, resultEndDate: "2099-02-10" }), profA)).id;
    const timed = ok(await saveLottery(u1, hid, null, base({ resultDate: { precision: "date_time", date: "2099-02-07", time: "12:00" }, resultEndDate: "2099-02-10" }), profA)).id;
    const d = await loadAppData(u1);
    const get = (id: string) => d.lotteries.find((l) => l.id === id)!;
    expect(get(single).resultEndDate).toBeUndefined();
    expect(get(range)).toMatchObject({ resultDate: { precision: "date_only", date: "2099-02-07" }, resultEndDate: "2099-02-10" });
    expect(get(timed).resultEndDate).toBe("2099-02-10");
    expect(get(timed).resultDate.precision).toBe("date_time"); // 開始の時刻は失われない
    // 編集で期間を外すと単一日に戻る
    ok(await saveLottery(u1, hid, range, base({ resultDate: { precision: "date_only", date: "2099-02-07", time: "" } }), profA));
    expect((await loadAppData(u1)).lotteries.find((l) => l.id === range)!.resultEndDate).toBeUndefined();
  });

  it("開始日が不明のときの最終日、開始日より前の最終日は保存できない", async () => {
    const noStart = await saveLottery(u1, hid, null, base({ resultEndDate: "2099-02-10" }), profA);
    expect(noStart.ok).toBe(false);
    const bad = await saveLottery(u1, hid, null, base({ resultDate: { precision: "date_only", date: "2099-02-07", time: "" }, resultEndDate: "2099-02-01" }), profA);
    expect(bad.ok).toBe(false);
  });

  it("DBの制約: 最終日が開始日より前の更新は拒否される（アプリを通さなくても）", async () => {
    const id = ok(await saveLottery(u1, hid, null, base({ resultDate: { precision: "date_only", date: "2099-03-05", time: "" }, resultEndDate: "2099-03-08" }), profA)).id;
    const bad = await u1.from("lotteries").update({ result_end_date: "2099-03-01" }).eq("id", id);
    expect(bad.error).not.toBeNull();
    const good = await u1.from("lotteries").update({ result_end_date: "2099-03-09" }).eq("id", id);
    expect(good.error).toBeNull();
  });

  it("他店舗への複製でも発表期間を引き継ぐ。既存の抽選（最終日なし）はそのまま読める", async () => {
    const src = ok(await saveLottery(u1, hid, null, base({ resultDate: { precision: "date_only", date: "2099-04-05", time: "" }, resultEndDate: "2099-04-08" }), profA)).id;
    const dup = ok(await duplicateLottery(u1, hid, src, [storeB], profA));
    const d = await loadAppData(u1);
    const copy = d.lotteries.find((l) => l.id === dup.ids[0])!;
    expect(copy.resultEndDate).toBe("2099-04-08");
    expect(d.lotteries.some((l) => l.resultEndDate === undefined)).toBe(true);
  });

  it("商品画像のサムネイル列がある（元画像の path は別に保持される）", async () => {
    const { error } = await u1.from("product_images").select("id,storage_path,thumb_path").limit(1);
    expect(error).toBeNull();
  });
});
