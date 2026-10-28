/**
 * Stage 5B の結合テスト（実Supabase・RLS適用下）: 店舗の位置・交通費、自宅の位置（保護）、世帯設定、AI利用ログ。
 *   npm run test:db   ※ マイグレーション 20261029000019 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 5B: 位置情報・設定・AI利用ログ", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  let storeId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しいRPCは生成型に無い
  const rpc = (db: Db, fn: string, args?: Record<string, unknown>) => (db as any).rpc(fn, args);
  const SECRET_ADDRESS = "兵庫県テスト市秘密町1-2-3";

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5b", 1);
    const b = await signInTestUser(admin, "s5b", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    const chain = (await u1.from("chains").insert({ household_id: hid1, name: "5B系列" }).select("id").single()).data!.id;
    storeId = (await u1.from("stores").insert({ household_id: hid1, chain_id: chain, name: "5B店", prefecture: "兵庫県" }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("店舗: 往復交通費は0〜100万円（未設定=NULL）。緯度経度は範囲内で、両方あるか両方ないか", async () => {
    const got = await u1.from("stores").select("round_trip_fare,memo,latitude,longitude").eq("id", storeId).single();
    expect(got.data).toEqual({ round_trip_fare: null, memo: "", latitude: null, longitude: null });
    const upd = (v: { round_trip_fare?: number | null; latitude?: number | null; longitude?: number | null; memo?: string }) => u1.from("stores").update(v).eq("id", storeId);
    expect((await upd({ round_trip_fare: 1200 })).error).toBeNull();
    expect((await upd({ round_trip_fare: -1 })).error).not.toBeNull();
    expect((await upd({ round_trip_fare: 1_000_001 })).error).not.toBeNull();
    expect((await upd({ latitude: 34.6948, longitude: 135.1955 })).error).toBeNull();
    expect((await upd({ latitude: 91, longitude: 135 })).error).not.toBeNull();
    expect((await upd({ latitude: 34, longitude: 181 })).error).not.toBeNull();
    expect((await upd({ latitude: null })).error).not.toBeNull(); // 片方だけは無効
    expect((await upd({ latitude: null, longitude: null, round_trip_fare: null })).error).toBeNull();
    expect((await upd({ memo: "x".repeat(1001) })).error).not.toBeNull();
  });

  it("自宅の位置: RPCでだけ保存でき、住所の文字列は通常の参照では読めない（専用の取得だけ）", async () => {
    // テーブルへの直接の書き込みは不可
    expect((await u1.from("household_settings").insert({ household_id: hid1, home_lat: 1, home_lng: 1 })).error).not.toBeNull();
    // 緯度経度は両方、範囲内
    expect((await rpc(u1, "save_home_location", { p_address: SECRET_ADDRESS, p_lat: 34.7, p_lng: null, p_actor: null })).error).not.toBeNull();
    expect((await rpc(u1, "save_home_location", { p_address: SECRET_ADDRESS, p_lat: 95, p_lng: 135, p_actor: null })).error).not.toBeNull();
    expect((await rpc(u1, "save_home_location", { p_address: "x".repeat(201), p_lat: 34.7, p_lng: 135.2, p_actor: null })).error).not.toBeNull();
    expect((await rpc(u1, "save_home_location", { p_address: SECRET_ADDRESS, p_lat: 34.6948, p_lng: 135.1955, p_actor: null })).error).toBeNull();

    // 住所の列は参照できない（select * も、住所を指定した参照も拒否）。設定画面が使う列は読める
    expect((await u1.from("household_settings").select("*")).error).not.toBeNull();
    expect((await u1.from("household_settings").select("home_address")).error).not.toBeNull();
    const ok = await u1.from("household_settings").select("home_lat,home_lng,travel_review_needed,card_display,distance_bands_km,ai_monthly_budget_jpy,auto_ai_enabled").single();
    expect(ok.error).toBeNull();
    expect(Number(ok.data!.home_lat)).toBeCloseTo(34.6948, 4);
    expect(ok.data!.travel_review_needed).toBe(false); // 初回の設定では見直しを促さない
    expect(ok.data!.ai_monthly_budget_jpy).toBe(3000);
    // 住所は専用の取得でだけ返る。他世帯には見えない
    expect((await rpc(u1, "get_home_address")).data).toBe(SECRET_ADDRESS);
    expect((await rpc(u2, "get_home_address")).data ?? null).toBeNull();
    expect((await u2.from("household_settings").select("home_lat")).data ?? []).toHaveLength(0);
    // 未ログインは不可
    const anon = anonClient();
    expect((await rpc(anon as unknown as Db, "get_home_address")).error).not.toBeNull();
    expect((await rpc(anon as unknown as Db, "save_home_location", { p_address: "x", p_lat: 1, p_lng: 1, p_actor: null })).error).not.toBeNull();
  });

  it("自宅の位置が変わると交通費の見直しを促し、確認すると外れる。操作履歴には住所・座標の値を残さない", async () => {
    expect((await rpc(u1, "save_home_location", { p_address: SECRET_ADDRESS, p_lat: 35.0, p_lng: 135.5, p_actor: null })).error).toBeNull();
    const after = await u1.from("household_settings").select("travel_review_needed").single();
    expect(after.data!.travel_review_needed).toBe(true);
    expect((await rpc(u1, "ack_travel_review", { p_actor: null })).error).toBeNull();
    expect((await u1.from("household_settings").select("travel_review_needed").single()).data!.travel_review_needed).toBe(false);
    // 住所だけ直して位置が同じなら見直しは不要
    expect((await rpc(u1, "save_home_location", { p_address: SECRET_ADDRESS + "（修正）", p_lat: 35.0, p_lng: 135.5, p_actor: null })).error).toBeNull();
    expect((await u1.from("household_settings").select("travel_review_needed").single()).data!.travel_review_needed).toBe(false);

    const { data: logs } = await u1.from("audit_logs").select("after_json,before_json").eq("entity_type", "household_settings");
    expect(logs!.length).toBeGreaterThanOrEqual(3);
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain("秘密町");
    expect(dump).not.toContain("35.0");
    expect(dump).not.toContain("135.5");
    expect(dump).toContain("home_location");
  });

  it("世帯設定（カード表示・距離区分・AI予算）: 検証つきで保存でき、不正な値は拒否される", async () => {
    const save = (over: Record<string, unknown>) =>
      rpc(u1, "save_household_settings", { p_card_display: { deadline: true, travelCost: true }, p_bands: [5, 15, 30, 60], p_budget: 3000, p_auto_ai: true, p_actor: null, ...over });
    expect((await save({})).error).toBeNull();
    const got = await u1.from("household_settings").select("card_display,distance_bands_km,ai_monthly_budget_jpy,auto_ai_enabled").single();
    expect(got.data!.card_display).toEqual({ deadline: true, travelCost: true });
    expect(got.data!.distance_bands_km).toEqual([5, 15, 30, 60]);
    expect((await save({ p_card_display: { evil: true } })).error).not.toBeNull();
    expect((await save({ p_card_display: { deadline: "yes" } })).error).not.toBeNull();
    expect((await save({ p_bands: [5, 5, 30, 60] })).error).not.toBeNull();
    expect((await save({ p_bands: [5, 15, 30] })).error).not.toBeNull();
    expect((await save({ p_bands: [0, 15, 30, 60] })).error).not.toBeNull();
    expect((await save({ p_budget: -1 })).error).not.toBeNull();
    expect((await save({ p_budget: 1_000_001 })).error).not.toBeNull();
    expect((await save({ p_budget: 2500, p_auto_ai: false })).error).toBeNull();
    const again = await u1.from("household_settings").select("ai_monthly_budget_jpy,auto_ai_enabled").single();
    expect(again.data).toEqual({ ai_monthly_budget_jpy: 2500, auto_ai_enabled: false });
    // 他世帯の設定には影響しない（世帯2は未設定のまま）
    expect((await u2.from("household_settings").select("home_lat")).data ?? []).toHaveLength(0);
    void hid2;
  });

  it("AI利用ログ: 使用モデルを記録でき、費用の集計に使える", async () => {
    const row = { household_id: hid1, kind: "text", engine: "anthropic", status: "ok", source_host: null, input_tokens: 1200, output_tokens: 400, model: "claude-haiku-5-5" };
    expect((await u1.from("ai_extraction_logs").insert(row)).error).toBeNull();
    expect((await u1.from("ai_extraction_logs").insert({ ...row, model: "x".repeat(61) })).error).not.toBeNull();
    const got = await u1.from("ai_extraction_logs").select("model,input_tokens").eq("model", "claude-haiku-5-5");
    expect(got.data).toHaveLength(1);
  });
});
