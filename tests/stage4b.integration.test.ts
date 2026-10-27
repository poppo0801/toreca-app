/**
 * Stage 4B（と 4A 残機能）の結合テスト（実Supabase・RLS適用下）: AI読み取りの利用ログ、商品画像の表示調整。
 *   npm run test:db   ※ マイグレーション 20261028000016 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 4B: AI利用ログ・画像表示調整", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let productId: string;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s4b", 1);
    const b = await signInTestUser(admin, "s4b", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    const p = await u1.from("products").insert({ household_id: hid1, official_name: "4B商品", product_code: "4B-1", product_code_kind: "custom" }).select("id").single();
    productId = p.data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("画像の表示調整は既定が等倍・中央で、範囲外は拒否される。他世帯は変更できない", async () => {
    const ins = await u1.from("product_images").insert({ household_id: hid1, product_id: productId, kind: "box", storage_path: `${hid1}/${productId}/box-x.png`, sha256: "a".repeat(64), width: 10, height: 20 }).select("display_scale,offset_x,offset_y").single();
    expect(ins.error).toBeNull();
    expect(Number(ins.data!.display_scale)).toBe(1);
    expect([ins.data!.offset_x, ins.data!.offset_y]).toEqual([0, 0]);
    const ok = await u1.from("product_images").update({ display_scale: 1.5, offset_x: -10, offset_y: 20 }).eq("product_id", productId).eq("kind", "box").select("id");
    expect(ok.error).toBeNull();
    expect(ok.data).toHaveLength(1);
    expect((await u1.from("product_images").update({ display_scale: 5 }).eq("product_id", productId)).error).not.toBeNull();
    expect((await u1.from("product_images").update({ offset_x: 80 }).eq("product_id", productId)).error).not.toBeNull();
    // 他世帯の更新は0行（RLS）
    const other = await u2.from("product_images").update({ display_scale: 2 }).eq("product_id", productId).select("id");
    expect(other.data ?? []).toHaveLength(0);
    expect(Number((await u1.from("product_images").select("display_scale").eq("product_id", productId).single()).data!.display_scale)).toBe(1.5);
  });

  it("AI利用ログ: 自世帯のログだけ記録・参照でき、他世帯・未ログインは不可。本文やキーの保存先はない", async () => {
    const row = { household_id: hid1, kind: "text", engine: "mock", status: "ok", source_host: null, input_tokens: 10, output_tokens: 5 };
    expect((await u1.from("ai_extraction_logs").insert(row)).error).toBeNull();
    expect((await u1.from("ai_extraction_logs").select("id")).data).toHaveLength(1);
    // 他世帯からは見えない・他世帯のIDでは書けない
    expect((await u2.from("ai_extraction_logs").select("id")).data).toHaveLength(0);
    expect((await u2.from("ai_extraction_logs").insert({ ...row, household_id: hid1 })).error).not.toBeNull();
    // 別ユーザーのIDを偽装できない
    const { data: me } = await u1.auth.getUser();
    expect((await u1.from("ai_extraction_logs").insert({ ...row, user_id: "00000000-0000-4000-8000-000000000000" })).error).not.toBeNull();
    expect(me.user).not.toBeNull();
    // 不正な値は拒否
    expect((await u1.from("ai_extraction_logs").insert({ ...row, status: "weird" })).error).not.toBeNull();
    expect((await u1.from("ai_extraction_logs").insert({ ...row, engine: "other" })).error).not.toBeNull();
    // ログは更新・削除できない（利用者は追記のみ）
    expect((await u1.from("ai_extraction_logs").update({ status: "failed" }).eq("household_id", hid1).select("id")).data ?? []).toHaveLength(0);
    expect((await u1.from("ai_extraction_logs").delete().eq("household_id", hid1).select("id")).data ?? []).toHaveLength(0);
    expect((await u1.from("ai_extraction_logs").select("id")).data).toHaveLength(1);
    // 未ログイン
    const anon = anonClient();
    expect((await anon.from("ai_extraction_logs").select("id")).data ?? []).toHaveLength(0);
    expect((await anon.from("ai_extraction_logs").insert(row)).error).not.toBeNull();
  });
});
