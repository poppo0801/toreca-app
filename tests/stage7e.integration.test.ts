/**
 * Stage 7E の結合テスト（実Supabase・RLS適用下・架空データのみ）:
 * 購入記録の標準画像（item_default_images）の保存・世帯分離・制約、支出品目（シングルカード・その他）の保存と収支の集計への反映。
 *   npm run test:db   ※ マイグレーション 20261130000078 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 7E: 標準画像と支出品目", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let h1: string;
  let h2: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に含まれない場合がある
  const x = (db: unknown) => db as any;
  const sha = "a".repeat(64);

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7e", 1);
    const b = await signInTestUser(admin, "s7e", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    h1 = (await u1.rpc("bootstrap_household")).data as string;
    h2 = (await u2.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("世帯のメンバーは品目別の標準画像を登録・差し替え・削除でき、AppData に参照URLとして載る。品目はシングルカード・その他のみ", async () => {
    const ins = await x(u1).from("item_default_images").insert({ household_id: h1, category: "single_card", storage_path: `${h1}/default-images/single_card-aaaaaaaaaaaa.png`, sha256: sha });
    expect(ins.error).toBeNull();
    const data = await loadAppData(u1, h1);
    expect(data.defaultImages?.single_card?.url).toContain("/api/default-image/single_card?v=aaaaaaaaaaaa");
    expect(data.defaultImages?.other).toBeUndefined();
    // 差し替え（同じ品目は1つ）
    const up = await x(u1).from("item_default_images").upsert({ household_id: h1, category: "single_card", storage_path: `${h1}/default-images/single_card-bbbbbbbbbbbb.png`, sha256: "b".repeat(64) }, { onConflict: "household_id,category" });
    expect(up.error).toBeNull();
    expect(((await x(u1).from("item_default_images").select("category")).data ?? []).length).toBe(1);
    // 品目の制約
    expect((await x(u1).from("item_default_images").insert({ household_id: h1, category: "goods", storage_path: "p", sha256: sha })).error).not.toBeNull();
    // 削除
    expect((await x(u1).from("item_default_images").delete().eq("category", "single_card")).error).toBeNull();
    expect(((await x(u1).from("item_default_images").select("category")).data ?? []).length).toBe(0);
  });

  it("他の世帯の標準画像は読めず、作成も変更もできない（RLS）", async () => {
    await x(u1).from("item_default_images").insert({ household_id: h1, category: "other", storage_path: `${h1}/default-images/other-cccccccccccc.png`, sha256: "c".repeat(64) });
    expect(((await x(u2).from("item_default_images").select("category")).data ?? []).length).toBe(0);
    expect((await x(u2).from("item_default_images").insert({ household_id: h1, category: "single_card", storage_path: "p", sha256: sha })).error).not.toBeNull();
    await x(u2).from("item_default_images").delete().eq("household_id", h1);
    expect(((await x(u1).from("item_default_images").select("category")).data ?? []).length).toBe(1);
    expect((await loadAppData(u2, h2)).defaultImages?.other).toBeUndefined();
  });

  it("支出の品目 single_card・other を保存でき、既存の品目の記録は変わらない（形式だけの制約）", async () => {
    const mk = async (category: string, label: string, qty: number, amount: number) => {
      const p = await u1.from("purchases").insert({ household_id: h1, category, source_kind: "manual", purchased_date: "2026-11-05", channel: "store" } as never).select("id").single();
      expect(p.error).toBeNull();
      const i = await u1.from("purchase_items").insert({ household_id: h1, purchase_id: p.data!.id, quantity: qty, unit: "piece", product_label: label, amount_paid: amount } as never);
      expect(i.error).toBeNull();
      return p.data!.id as string;
    };
    await mk("pokemon_card", "既存のカード", 1, 1000);
    await mk("single_card", "ピカチュウ", 6, 6260);
    await mk("other", "ストレージ", 1, 700);
    const d = await loadAppData(u1, h1);
    const byCat = Object.fromEntries(d.purchases.map((p) => [p.category, p.items[0]?.amountPaid]));
    expect(byCat).toMatchObject({ pokemon_card: 1000, single_card: 6260, other: 700 });
    expect((await u1.from("purchases").insert({ household_id: h1, category: "Bad Category", source_kind: "manual", purchased_date: "2026-11-05", channel: "store" } as never)).error).not.toBeNull();
  });
});
