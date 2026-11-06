/**
 * Stage 6L の結合テスト（実Supabase・RLS適用下）: 店舗なしの抽選の保存、系列の別名の制約。
 *   npm run test:db   ※ マイグレーション 20261121000065 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { saveLottery, type Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 6L: 店舗なしの抽選・系列の別名", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let hid: string;
  let actor: string;
  let chainId: string;
  let productId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列は生成型に無い場合がある
  const x = (db: unknown) => db as any;

  const input = (over: Partial<LotteryInput> = {}): LotteryInput => ({
    chain: { id: chainId, name: "" },
    store: { id: null, name: "", prefecture: "" },
    noStore: true,
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: productId, name: "" }, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX,
    applyDeadline: { precision: "date_only", date: "2099-12-31", time: "" },
    resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "shipping",
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
    ...over,
  });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6l", 1);
    ids.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    actor = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    chainId = (await u1.from("chains").insert({ household_id: hid, name: "6L単独店舗オンライン" }).select("id").single()).data!.id;
    productId = (await u1.from("products").insert({ household_id: hid, official_name: "6Lテスト拡張パック", packs_per_box: 30 }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("店舗が空でも系列だけで抽選を登録できる。store_id は NULL で、ダミーの店舗は作られない", async () => {
    const before = (await u1.from("stores").select("id").eq("household_id", hid)).data ?? [];
    const r = await saveLottery(u1, hid, null, input(), actor);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const row = (await x(u1).from("lotteries").select("id,chain_id,store_id").eq("id", r.value.id).single()).data;
    expect(row.store_id).toBeNull();
    expect(row.chain_id).toBe(chainId);
    expect(((await u1.from("stores").select("id").eq("household_id", hid)).data ?? []).length).toBe(before.length);
  });

  it("編集しても店舗なしのまま。あとから店舗を指定でき、その店舗は系列の店舗として作られる", async () => {
    const r = await saveLottery(u1, hid, null, input({ memo: "初回" }), actor);
    if (!r.ok) throw new Error("save");
    const again = await saveLottery(u1, hid, r.value.id, input({ memo: "編集後" }), actor);
    expect(again.ok).toBe(true);
    expect((await x(u1).from("lotteries").select("store_id,memo").eq("id", r.value.id).single()).data).toEqual({ store_id: null, memo: "編集後" });
    const withStore = await saveLottery(u1, hid, r.value.id, input({ store: { id: null, name: "オンライン本店", prefecture: "" }, noStore: false }), actor);
    expect(withStore.ok).toBe(true);
    const s = (await x(u1).from("lotteries").select("store_id").eq("id", r.value.id).single()).data;
    expect(s.store_id).not.toBeNull();
    expect((await u1.from("stores").select("chain_id").eq("id", s.store_id)).data![0].chain_id).toBe(chainId);
  });

  it("系列の別名は同じ世帯の中で正規化した表記が一意（他の系列と同じ別名は登録できない）。別名は同じ系列IDに紐づく", async () => {
    const other = (await u1.from("chains").insert({ household_id: hid, name: "6L別の系列" }).select("id").single()).data!.id;
    const ok = await u1.from("chain_aliases").insert({ household_id: hid, chain_id: chainId, alias: "ハレツー6L", normalized_alias: "はれつー6l" });
    expect(ok.error).toBeNull();
    const dup = await u1.from("chain_aliases").insert({ household_id: hid, chain_id: other, alias: "ハレツー6L", normalized_alias: "はれつー6l" });
    expect(dup.error?.code).toBe("23505");
    const rows = (await u1.from("chain_aliases").select("chain_id,alias").eq("household_id", hid)).data ?? [];
    expect(rows.filter((a) => a.alias === "ハレツー6L").map((a) => a.chain_id)).toEqual([chainId]);
  });
});
