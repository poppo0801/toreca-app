/**
 * Stage 7S: 店舗の削除（参照なしのみ）・参照ありはアーカイブ・オンライン店舗の統合。実Supabase・RLS適用下・架空データのみ。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { deleteStore, mergeStores, storeReferences } from "@/lib/server/store-admin-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 7S: 店舗の削除・統合", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db: Db;
  let hid: string;
  let chain: string;
  let product: string;

  const mkStore = async (name: string, kind = "physical") =>
    (await db.from("stores").insert({ household_id: hid, chain_id: chain, name, sales_kind: kind } as never).select("id").single()).data!.id as string;
  const mkLottery = async (storeId: string) => {
    const r = await db
      .from("lotteries")
      .insert({ household_id: hid, chain_id: chain, store_id: storeId, store_mode: "fixed", apply_deadline_precision: "date_only", apply_deadline_date: "2099-01-01", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "manual" } as never)
      .select("id")
      .single();
    expect(r.error).toBeNull();
    await db.from("lottery_items").insert({ household_id: hid, lottery_id: r.data!.id, product_id: product, quantity: 1, unit: "box" } as never);
    return r.data!.id as string;
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7s", 1);
    userIds.push(a.userId);
    db = a.db;
    hid = (await db.rpc("bootstrap_household")).data as string;
    chain = (await db.from("chains").insert({ household_id: hid, name: "7S系列" } as never).select("id").single()).data!.id as string;
    product = (await db.from("products").insert({ household_id: hid, official_name: "7S商品" } as never).select("id").single()).data!.id as string;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("参照のない店舗は削除でき、抽選から参照されている店舗は削除できない（件数を返す）", async () => {
    const free = await mkStore("未使用店");
    expect((await storeReferences(db, free)).ok).toBe(true);
    expect((await deleteStore(db, free)).ok).toBe(true);
    expect((await db.from("stores").select("id").eq("id", free)).data).toHaveLength(0);

    const used = await mkStore("使用中店");
    await mkLottery(used);
    const refs = await storeReferences(db, used);
    expect(refs.ok && refs.value.lotteries).toBe(1);
    const del = await deleteStore(db, used);
    expect(del.ok).toBe(false);
    expect((await db.from("stores").select("id").eq("id", used)).data).toHaveLength(1);
  });

  it("アーカイブした店舗も抽選との紐付けは残る", async () => {
    const s = await mkStore("アーカイブ店");
    const l = await mkLottery(s);
    await db.from("stores").update({ archived_at: new Date().toISOString() }).eq("id", s);
    expect((await db.from("lotteries").select("store_id").eq("id", l).single()).data?.store_id).toBe(s);
  });

  it("オンライン店舗の統合: 抽選が統合先に移り、統合元の名称は別名に残り、統合元は削除される", async () => {
    const into = await mkStore("通販", "online_only");
    const from = await mkStore("オンライン", "physical");
    const l = await mkLottery(from);
    const m = await mergeStores(db, from, into, null);
    expect(m.ok && m.value.lotteries).toBe(1);
    expect((await db.from("lotteries").select("store_id").eq("id", l).single()).data?.store_id).toBe(into);
    expect((await db.from("stores").select("id").eq("id", from)).data).toHaveLength(0);
    const al = await db.from("store_aliases").select("alias").eq("store_id", into);
    expect(al.data?.map((a) => a.alias)).toContain("オンライン");
  });

  it("別の系列の店舗とは統合できない", async () => {
    const other = (await db.from("chains").insert({ household_id: hid, name: "7S別系列" } as never).select("id").single()).data!.id as string;
    const a = await mkStore("店A");
    const b = (await db.from("stores").insert({ household_id: hid, chain_id: other, name: "店B" } as never).select("id").single()).data!.id as string;
    expect((await mergeStores(db, a, b, null)).ok).toBe(false);
  });
});
