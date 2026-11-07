/**
 * Stage 6R の結合テスト（実Supabase・RLS適用下）。
 *   npm run test:db   ※ マイグレーション 20261128000076 の適用後に実行する
 * プロフィール別のカード並び順（保存・置き換え・プロフィール間の独立・カード情報を変えない・世帯分離）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 6R: プロフィール別のカード並び順", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let profs: { id: string }[];
  const cards: string[] = [];
  let otherCard: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
  const x = (db: unknown) => db as any;
  const orderOf = async (profile: string) =>
    ((await x(u1).from("card_display_orders").select("card_id,position").eq("profile_id", profile).order("position")).data as { card_id: string; position: number }[]).map((r) => r.card_id);
  const save = (db: Db, profile: string, list: string[]) => x(db).rpc("set_card_display_order", { p_profile: profile, p_cards: list });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6r", 1);
    const b = await signInTestUser(admin, "s6r", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    const hid2 = (await u2.rpc("bootstrap_household")).data as string;
    profs = (await u1.from("profiles").select("id").order("sort_order")).data!;
    for (const [i, n] of ["ブラッキー", "エーフィ", "リザードン", "ピカチュウ"].entries()) {
      const r = await x(admin).from("card_masters").insert({ household_id: hid, name: n, card_number: `${i + 1}/9`, set_code: "T", rarity: "RR" }).select("id").single();
      expect(r.error).toBeNull();
      cards.push(r.data.id);
    }
    otherCard = (await x(admin).from("card_masters").insert({ household_id: hid2, name: "他世帯のカード", card_number: "9/9", set_code: "T", rarity: "RR" }).select("id").single()).data.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("プロフィールごとに独立した順序を保存でき、保存後に同じ順で復元できる", async () => {
    const [A, B] = [profs[0].id, profs[1].id];
    expect((await save(u1, A, [cards[0], cards[1], cards[2]])).error).toBeNull(); // ブラッキー→エーフィ→リザードン
    expect((await save(u1, B, [cards[2], cards[0], cards[1]])).error).toBeNull(); // リザードン→ブラッキー→エーフィ
    expect(await orderOf(A)).toEqual([cards[0], cards[1], cards[2]]);
    expect(await orderOf(B)).toEqual([cards[2], cards[0], cards[1]]);
  });
  it("保存し直すと置き換わり、Aの変更はBの順序に影響しない。再送しても同じ", async () => {
    const [A, B] = [profs[0].id, profs[1].id];
    await save(u1, A, [cards[1], cards[0], cards[2], cards[3]]);
    await save(u1, A, [cards[1], cards[0], cards[2], cards[3]]);
    expect(await orderOf(A)).toEqual([cards[1], cards[0], cards[2], cards[3]]);
    expect(await orderOf(B)).toEqual([cards[2], cards[0], cards[1]]);
  });
  it("順序の保存では、カード・所有記録・お気に入りなどの元の情報は変わらない", async () => {
    const before = (await x(u1).from("card_masters").select("id,name,created_at,rarity").eq("household_id", hid).order("id")).data;
    await save(u1, profs[2].id, [cards[3], cards[2]]);
    const after = (await x(u1).from("card_masters").select("id,name,created_at,rarity").eq("household_id", hid).order("id")).data;
    expect(after).toEqual(before);
  });
  it("重複・他世帯のカード・存在しないカードは拒否され、既存の順序は変わらない", async () => {
    const A = profs[0].id;
    const before = await orderOf(A);
    expect((await save(u1, A, [cards[0], cards[0]])).error).not.toBeNull();
    expect((await save(u1, A, [cards[0], otherCard])).error).not.toBeNull();
    expect((await save(u1, A, [cards[0], crypto.randomUUID()])).error).not.toBeNull();
    expect(await orderOf(A)).toEqual(before);
  });
  it("他世帯のユーザーは、順序を読めず、保存もできない", async () => {
    expect((await x(u2).from("card_display_orders").select("card_id")).data).toHaveLength(0);
    expect((await save(u2, profs[0].id, [cards[0]])).error).not.toBeNull();
    expect((await x(u2).from("card_display_orders").insert({ household_id: hid, profile_id: profs[0].id, card_id: cards[0], position: 0 })).error).not.toBeNull();
  });
  it("カードを削除（アーカイブではなく行の削除）すると、その順序の行も消える（孤立しない）", async () => {
    const extra = (await x(admin).from("card_masters").insert({ household_id: hid, name: "削除するカード", card_number: "2/2", set_code: "T", rarity: "RR" }).select("id").single()).data.id;
    await save(u1, profs[1].id, [extra, cards[0]]);
    await x(admin).from("card_masters").delete().eq("id", extra);
    expect(await orderOf(profs[1].id)).toEqual([cards[0]]);
  });
});
