/**
 * Stage 6G の結合テスト（実Supabase・RLS適用下）: 取得した相場（card_market_prices）と照合の確定（card_market_links）。
 *   npm run test:db   ※ マイグレーション 20261116000060 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 6G: 取得した相場", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let cardId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
  const x = (db: Db) => db as any;
  const row = (over: Record<string, unknown> = {}) => ({ household_id: hid1, card_id: cardId, kind: "sale", median_yen: 56000, low_yen: 49800, high_yen: 59800, sample_count: 3, shops: [{ shop: "テスト店", price: 56000 }], source: "ポケカ価格比較", source_url: "https://card.pricebest.jp/data/", match_key: "SAR|テスト", ...over });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6g", 1);
    const b = await signInTestUser(admin, "s6g", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    const r = await x(u1).rpc("save_card_with_holding", { p: { card: { name: "テストex", card_number: `${Date.now() % 1000000}/100`, set_code: "TS1", rarity: "SAR" }, holding: { quantity: 1, unit_price_yen: 1000 } }, p_actor: null });
    if (r.error) throw new Error("save_card: " + JSON.stringify(r.error));
    cardId = r.data as string;
  });
  afterAll(async () => {
    // テスト世帯の削除関数は相場の表を知らないため、先にこの世帯の相場の行を消してから世帯ごと削除する
    if (hid1) {
      await admin.from("card_market_prices" as never).delete().eq("household_id", hid1);
      await admin.from("card_market_links" as never).delete().eq("household_id", hid1);
    }
    await cleanupTestUsers(admin, ids);
  });

  it("販売・買取を別に保存でき、同じカード×区分は上書き（upsert）で1行のまま。手動の参考相場には触れない", async () => {
    const first = await x(u1).from("card_market_prices").upsert([row(), row({ kind: "buyback", median_yen: 44000, low_yen: 44000, high_yen: 44000, sample_count: 1 })], { onConflict: "card_id,kind" });
    expect(first.error, JSON.stringify(first.error) + " cardId=" + cardId).toBeNull();
    expect((await x(u1).from("card_market_prices").upsert([row({ median_yen: 57000 })], { onConflict: "card_id,kind" })).error).toBeNull();
    const rows = (await x(u1).from("card_market_prices").select("kind,median_yen,sample_count").eq("card_id", cardId).order("kind")).data;
    expect(rows).toEqual([
      { kind: "buyback", median_yen: 44000, sample_count: 1 },
      { kind: "sale", median_yen: 57000, sample_count: 3 },
    ]);
    expect((await x(u1).from("card_prices").select("id").eq("card_id", cardId)).data ?? []).toHaveLength(0);
  });

  it("不正な値は拒否（区分・件数0・負の価格・不正なURL）", async () => {
    expect((await x(u1).from("card_market_prices").insert(row({ kind: "other" }))).error).not.toBeNull();
    expect((await x(u1).from("card_market_prices").update({ sample_count: 0 }).eq("card_id", cardId)).error).not.toBeNull();
    expect((await x(u1).from("card_market_prices").update({ median_yen: -1 }).eq("card_id", cardId)).error).not.toBeNull();
    expect((await x(u1).from("card_market_prices").update({ source_url: "javascript:alert(1)" }).eq("card_id", cardId)).error).not.toBeNull();
  });

  it("他世帯からは見えず、世帯を偽った挿入も不可。未ログインも不可。削除はできない", async () => {
    expect((await x(u2).from("card_market_prices").select("id")).data ?? []).toHaveLength(0);
    expect((await x(u2).from("card_market_prices").insert(row())).error).not.toBeNull();
    expect((await x(anonClient() as unknown as Db).from("card_market_prices").select("id")).data ?? []).toHaveLength(0);
    expect((await x(u1).from("card_market_prices").delete().eq("card_id", cardId).select()).data ?? []).toHaveLength(0);
  });

  it("照合の確定（card_market_links）はカードごとに1つ。更新でき、他世帯からは見えない", async () => {
    const put = (key: string) => x(u1).from("card_market_links").upsert({ household_id: hid1, card_id: cardId, match_key: key }, { onConflict: "card_id" });
    expect((await put("AR|a")).error).toBeNull();
    expect((await put("AR|b")).error).toBeNull();
    expect((await x(u1).from("card_market_links").select("match_key").eq("card_id", cardId)).data).toEqual([{ match_key: "AR|b" }]);
    expect((await x(u2).from("card_market_links").select("id")).data ?? []).toHaveLength(0);
    expect((await x(u2).from("card_market_links").insert({ household_id: hid1, card_id: cardId, match_key: "x" })).error).not.toBeNull();
  });
});
