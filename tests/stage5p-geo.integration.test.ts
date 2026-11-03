/**
 * 店舗住所の位置情報の自動取得（実Supabase・RLS適用下。架空データ・外部APIは差し替え）:
 * 取得待ち→取得済み、住所変更での座標破棄と再取得、住所削除、住所不完全、取得失敗と回数制限つき再試行、取得中の住所変更で古い結果を捨てる、失敗だけの再取得。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processGeocodeBatch, requeueFailedGeocoding } from "@/lib/server/geocode-service";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const gsi = (items: { title: string; lat: number; lng: number }[]) =>
  (async () => new Response(JSON.stringify(items.map((i) => ({ geometry: { type: "Point", coordinates: [i.lng, i.lat] }, properties: { title: i.title } }))), { status: 200 })) as unknown as typeof fetch;
const failing = (status: number) => (async () => new Response("x", { status })) as unknown as typeof fetch;

describe.skipIf(!dbTestsEnabled)("店舗住所の位置情報（自動取得）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db: Db;
  let hid: string;
  let chain: string;
  const ADDR = "兵庫県神戸市中央区東川崎町1-7-2";
  const FOUND = gsi([{ title: "兵庫県神戸市中央区東川崎町１丁目", lat: 34.678512, lng: 135.181801 }]);

  const mk = async (name: string, address: string, extra: Record<string, unknown> = {}) => {
    const { data, error } = await db.from("stores").insert({ household_id: hid, chain_id: chain, name, prefecture: "兵庫県", address_optional: address, ...extra }).select("id").single();
    expect(error).toBeNull();
    return data!.id;
  };
  const get = async (id: string) => (await db.from("stores").select("latitude,longitude,geo_status,geo_attempts,geo_error,geo_address,address_optional").eq("id", id).single()).data!;
  const run = (fetcher: typeof fetch, limit = 20) => processGeocodeBatch(db, { limit, fetcher, gapMs: 0 });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5pgeo", 1);
    userIds.push(a.userId);
    db = a.db;
    hid = (await db.rpc("bootstrap_household")).data as string;
    chain = (await db.from("chains").insert({ household_id: hid, name: "位置系列" }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("住所つきで登録すると取得待ちになり、取得すると座標・取得済みになる（住所なしは取得対象外）", async () => {
    const withAddr = await mk("取得店", ADDR);
    const noAddr = await mk("住所なし店", "");
    expect((await get(withAddr)).geo_status).toBe("pending");
    expect((await get(noAddr)).geo_status).toBe("none");
    const r = await run(FOUND);
    expect(r.ok).toBe(1);
    const s = await get(withAddr);
    expect(s).toMatchObject({ geo_status: "ok", geo_address: ADDR, geo_attempts: 0 });
    expect(Number(s.latitude)).toBeCloseTo(34.678512, 5);
    expect((await get(noAddr)).geo_status).toBe("none");
  });

  it("住所を変更すると古い座標は破棄されて取得待ちになり、再取得で新しい座標になる", async () => {
    const id = await mk("変更店", ADDR);
    await run(FOUND);
    expect((await get(id)).geo_status).toBe("ok");
    await db.from("stores").update({ address_optional: "兵庫県神戸市須磨区須磨浦通2-1-1" }).eq("id", id);
    expect(await get(id)).toMatchObject({ latitude: null, longitude: null, geo_status: "pending", geo_address: null });
    await run(gsi([{ title: "兵庫県神戸市須磨区須磨浦通２丁目", lat: 34.6409, lng: 135.1246 }]));
    const s = await get(id);
    expect(s.geo_status).toBe("ok");
    expect(Number(s.latitude)).toBeCloseTo(34.6409, 4);
  });

  it("住所を削除すると座標も消え、距離が出続けない。手入力の座標つきで住所を変えた場合は手入力を採用する", async () => {
    const id = await mk("削除店", ADDR);
    await run(FOUND);
    await db.from("stores").update({ address_optional: "" }).eq("id", id);
    expect(await get(id)).toMatchObject({ latitude: null, longitude: null, geo_status: "none" });
    const id2 = await mk("手入力店", ADDR);
    await db.from("stores").update({ address_optional: "兵庫県神戸市灘区岩屋中町4-2-1", latitude: 34.7, longitude: 135.2 }).eq("id", id2);
    expect(await get(id2)).toMatchObject({ geo_status: "ok" });
    expect(Number((await get(id2)).latitude)).toBeCloseTo(34.7, 4);
  });

  it("住所不完全は取得対象から除外（外部APIを呼ばない）。補完すると取得待ちに戻る", async () => {
    const id = await mk("不完全店", "三宮駅前");
    let called = 0;
    const spy = (async () => (called++, new Response("[]"))) as unknown as typeof fetch;
    const r = await run(spy);
    expect(r.incomplete).toBeGreaterThanOrEqual(1);
    expect(called).toBe(0);
    expect(await get(id)).toMatchObject({ geo_status: "incomplete", latitude: null });
    await db.from("stores").update({ address_optional: ADDR }).eq("id", id);
    expect((await get(id)).geo_status).toBe("pending");
    await run(FOUND);
  });

  it("曖昧・該当なしは座標を保存せず「取得失敗」。別の場所の座標を推測しない", async () => {
    const a = await mk("曖昧店", ADDR);
    await run(gsi([{ title: "兵庫県神戸市中央区", lat: 34.69, lng: 135.19 }]));
    expect(await get(a)).toMatchObject({ geo_status: "failed", geo_error: "ambiguous", latitude: null });
    const b = await mk("該当なし店", "兵庫県神戸市垂水区塩屋町9-9-9");
    await run(gsi([]));
    expect(await get(b)).toMatchObject({ geo_status: "failed", geo_error: "no_match", latitude: null });
  });

  it("一時的なエラーは回数制限つきで再試行し、上限で取得失敗。失敗だけを取得待ちへ戻して再取得できる", async () => {
    const id = await mk("一時エラー店", ADDR);
    await run(failing(503));
    expect(await get(id)).toMatchObject({ geo_status: "pending", geo_attempts: 1, geo_error: "temporary" });
    await run(failing(503));
    expect((await get(id)).geo_attempts).toBe(2);
    await run(failing(503));
    expect(await get(id)).toMatchObject({ geo_status: "failed", geo_error: "temporary_limit" });
    const n = await requeueFailedGeocoding(db);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await get(id)).toMatchObject({ geo_status: "pending", geo_attempts: 0 });
    await run(FOUND);
    expect((await get(id)).geo_status).toBe("ok");
  });

  it("取得中に住所が変わったら、古い住所の結果は新住所の座標を上書きしない", async () => {
    const id = await mk("競合店", ADDR);
    const slow = (async () => {
      // 外部APIの応答待ちの間に住所が変更される
      await db.from("stores").update({ address_optional: "兵庫県神戸市須磨区須磨浦通2-1-1" }).eq("id", id);
      return new Response(JSON.stringify([{ geometry: { type: "Point", coordinates: [135.181801, 34.678512] }, properties: { title: "兵庫県神戸市中央区東川崎町１丁目" } }]));
    }) as unknown as typeof fetch;
    await run(slow);
    expect(await get(id)).toMatchObject({ latitude: null, geo_status: "pending", address_optional: "兵庫県神戸市須磨区須磨浦通2-1-1" });
  });
});
