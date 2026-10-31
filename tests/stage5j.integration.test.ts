/**
 * Stage 5J の結合テスト（実Supabase・RLS適用下）: ユーザー表示順の保存と、応募・当落の記録がある商品・方式を編集で壊さないこと。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import { loadAppData, reorderProfiles, setApplied, setItemResults, type Db } from "@/lib/server/lottery-service";
import { saveLegacy as saveLottery, type LegacyInput } from "./helpers/legacy";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 5J: 表示順・商品/方式の保護", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profs: { id: string; label: string }[];
  let chainId: string;
  let storeA: string;
  let p1: string;
  let p2: string;
  let accA: string;

  const ok = <T,>(r: { ok: boolean; value?: T; error?: string }) => {
    expect(r.ok, r.error).toBe(true);
    return (r as { value: T }).value;
  };
  const base = (over: Partial<LegacyInput> = {}): LegacyInput => ({
    chainId, storeId: storeA, campaignId: null, newCampaign: null,
    items: [{ productId: p1, quantity: 1, unit: "box" }, { productId: p2, quantity: 1, unit: "box" }],
    multiMode: "all",
    applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_time", date: "2099-01-10", time: "23:59" }, resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveMethod: "store", applyMethod: "web",
    conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: [],
    eventState: "open", limitBasis: "account", limitMaxCount: 5, memo: "", applications: [], appliedAt: "", ...over,
  });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5j", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profs = (await u1.from("profiles").select("id,label").order("sort_order")).data!;
    const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
      const { data, error } = await p;
      expect(error).toBeNull();
      return data as { id: string };
    };
    chainId = (await must(u1.from("chains").insert({ household_id: hid, name: "5J電機" }).select("id").single())).id;
    storeA = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "5J-A店" }).select("id").single())).id;
    p1 = (await must(u1.from("products").insert({ household_id: hid, official_name: "5J商品1", packs_per_box: 20 }).select("id").single())).id;
    p2 = (await must(u1.from("products").insert({ household_id: hid, official_name: "5J商品2", packs_per_box: 20 }).select("id").single())).id;
    const fam = (await must(u1.from("family_groups").insert({ household_id: hid, label: "家族" }).select("id").single())).id;
    const adr = (await must(u1.from("address_groups").insert({ household_id: hid, label: "住所" }).select("id").single())).id;
    const idA = (await must(u1.from("identities").insert({ household_id: hid, display_label: "名義A", family_group_id: fam, address_group_id: adr }).select("id").single())).id;
    accA = (await must(u1.from("service_accounts").insert({ household_id: hid, chain_id: chainId, identity_id: idA, managed_by_profile_id: profs[0].id, account_label: "A-acc", membership_state: "eligible" }).select("id").single())).id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("ユーザーの表示順を保存でき、読み込みの並びに反映される。IDや他のデータは変わらない。人数が合わない・重複は拒否", async () => {
    const ids = profs.map((p) => p.id);
    const reversed = [...ids].reverse();
    ok(await reorderProfiles(u1, reversed, profs[0].id));
    const d = await loadAppData(u1);
    expect(d.profiles.map((p) => p.id)).toEqual(reversed);
    expect(new Set(d.profiles.map((p) => p.label))).toEqual(new Set(profs.map((p) => p.label)));
    expect((await reorderProfiles(u1, reversed.slice(1), profs[0].id)).ok).toBe(false); // 足りない
    expect((await reorderProfiles(u1, [...reversed.slice(1), reversed[1]], profs[0].id)).ok).toBe(false); // 重複
    expect((await reorderProfiles(u1, ["not-a-uuid"], profs[0].id)).ok).toBe(false);
    ok(await reorderProfiles(u1, ids, profs[0].id)); // 元に戻す
    expect((await loadAppData(u1)).profiles.map((p) => p.id)).toEqual(ids);
  });

  it("応募の記録がある抽選は、抽選方式を変更できない。商品別の当落がある商品は削除できない。記録のない商品は削除できる", async () => {
    const lot = ok(await saveLottery(u1, hid, null, base(), profs[0].id)).id;
    ok(await setApplied(u1, hid, lot, accA, true, profs[0].id));
    let d = await loadAppData(u1);
    const items = d.lotteries.find((l) => l.id === lot)!.items;
    const app = d.applications.find((a) => a.lotteryId === lot)!;
    ok(await setItemResults(u1, app.id, [{ itemId: items[0].id!, result: "won" }], profs[0].id));

    // 方式の変更は拒否（応募の記録があるため）
    const modeChange = await saveLottery(u1, hid, lot, base({ multiMode: "one_win", items: items.map((i) => ({ id: i.id, productId: i.productId, quantity: i.quantity, unit: i.unit })) }), profs[0].id);
    expect(modeChange.ok).toBe(false);
    // 当落のある商品の削除は拒否
    const removeScored = await saveLottery(u1, hid, lot, base({ items: [{ id: items[1].id, productId: items[1].productId, quantity: 1, unit: "box" }, { productId: p1, quantity: 1, unit: "box" }] }), profs[0].id);
    expect(removeScored.ok).toBe(false);
    d = await loadAppData(u1);
    expect(d.lotteries.find((l) => l.id === lot)!.items).toHaveLength(2);
    expect(d.applications.find((a) => a.id === app.id)!.itemResults[items[0].id!]).toBe("won"); // 当落はそのまま

    // 当落のない商品は、残りが2商品以上なら外せる（3商品→2商品）
    const lot2 = ok(await saveLottery(u1, hid, null, base({ items: [{ productId: p1, quantity: 1, unit: "box" }, { productId: p2, quantity: 1, unit: "box" }, { productId: p1, quantity: 2, unit: "pack" }] }), profs[0].id)).id;
    const it2 = (await loadAppData(u1)).lotteries.find((l) => l.id === lot2)!.items;
    ok(await saveLottery(u1, hid, lot2, base({ items: it2.slice(0, 2).map((i) => ({ id: i.id, productId: i.productId, quantity: i.quantity, unit: i.unit })) }), profs[0].id));
    expect((await loadAppData(u1)).lotteries.find((l) => l.id === lot2)!.items).toHaveLength(2);
  });
});
