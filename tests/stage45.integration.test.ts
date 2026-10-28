/**
 * Stage 4.5 の結合テスト（実Supabase・RLS適用下）: 初期値のまま保存した項目の記録、商品画像の表示範囲。
 *   npm run test:db   ※ マイグレーション 20261029000017 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 4.5: 未確認の初期値・画像の表示範囲", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u: Db;
  let hid: string;
  let productId: string;
  let lotteryId: string;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s45", 1);
    ids.push(a.userId);
    u = a.db;
    hid = (await u.rpc("bootstrap_household")).data as string;
    productId = (await u.from("products").insert({ household_id: hid, official_name: "45商品", product_code: "45-1", product_code_kind: "custom" }).select("id").single()).data!.id;
    const chain = (await u.from("chains").insert({ household_id: hid, name: "45系列" }).select("id").single()).data!.id;
    const store = (await u.from("stores").insert({ household_id: hid, chain_id: chain, name: "45店", prefecture: "兵庫県" }).select("id").single()).data!.id;
    const lot = await u.from("lotteries").insert({ household_id: hid, chain_id: chain, store_id: store }).select("id,unconfirmed_fields").single();
    lotteryId = lot.data!.id;
    expect(lot.data!.unconfirmed_fields).toEqual([]); // 既存・通常の抽選は確認済み扱い（空）
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("初期値のまま保存した項目を記録でき、許可された項目名以外は拒否される", async () => {
    expect((await u.from("lotteries").update({ unconfirmed_fields: ["applyMethod", "receiveMethod"] }).eq("id", lotteryId)).error).toBeNull();
    const got = await u.from("lotteries").select("unconfirmed_fields").eq("id", lotteryId).single();
    expect(got.data!.unconfirmed_fields).toEqual(["applyMethod", "receiveMethod"]);
    expect((await u.from("lotteries").update({ unconfirmed_fields: ["memo"] }).eq("id", lotteryId)).error).not.toBeNull();
    expect((await u.from("lotteries").update({ unconfirmed_fields: [] }).eq("id", lotteryId)).error).toBeNull();
  });

  it("画像の表示範囲(content_box)は正しい形式だけ保存でき、NULLは補正なし", async () => {
    const img = await u
      .from("product_images")
      .insert({ household_id: hid, product_id: productId, kind: "pack", storage_path: `${hid}/${productId}/pack-x.png`, sha256: "b".repeat(64), width: 266, height: 500 })
      .select("content_box")
      .single();
    expect(img.error).toBeNull();
    expect(img.data!.content_box).toBeNull();
    const upd = (box: unknown) => u.from("product_images").update({ content_box: box as never }).eq("product_id", productId).eq("kind", "pack");
    expect((await upd({ x: 9, y: 0, w: 248, h: 500 })).error).toBeNull();
    expect((await upd({ x: -1, y: 0, w: 10, h: 10 })).error).not.toBeNull();
    expect((await upd({ x: 0, y: 0, w: 0, h: 10 })).error).not.toBeNull();
    expect((await upd({ x: "a", y: 0, w: 10, h: 10 })).error).not.toBeNull();
    expect((await upd([1, 2, 3])).error).not.toBeNull();
    expect((await upd(null)).error).toBeNull();
  });
});
