/**
 * Stage 8D-2: 店舗所在地の調査結果の保存（開発用ローカルDB・RLS適用下・架空データ）。
 *   npm run test:db
 * 確認: 調査結果は専用の表に保存され、店舗マスターは変更されない／自世帯だけ／追記専用／AIの提案が検証を通らなければ保存内容に住所が入らない。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVAL_WORLD } from "@/lib/agent/store-location/world";
import { MockFetcher, MockSearch, MockStoreBrain, mockGeocode } from "@/lib/agent/store-location/mock";
import { researchStoreLocation } from "@/lib/agent/store-location/run";
import { countRealRunsToday, listResearch, listStoresForResearch, loadStoreTarget, saveResearch } from "@/lib/server/agent/store-location-service";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
const tbl = (d: Db) => (d as any).from("store_location_research");

describe.skipIf(!dbTestsEnabled)("Stage 8D-2: 店舗所在地の調査結果", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db1: Db, db2: Db;
  let hid1: string;
  let storeId: string;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s8d2", 1);
    const b = await signInTestUser(admin, "s8d2", 2);
    userIds.push(a.userId, b.userId);
    db1 = a.db;
    db2 = b.db;
    hid1 = (await db1.rpc("bootstrap_household")).data as string;
    await db2.rpc("bootstrap_household");
    const chain = (await db1.from("chains").insert({ household_id: hid1, name: "テスト書店" }).select("id").single()).data!.id as string;
    await db1.from("chains").insert({ household_id: hid1, name: "テスト通販ショップ" });
    storeId = (await db1.from("stores").insert({ household_id: hid1, chain_id: chain, name: "テスト書店 駅前店", prefecture: "東京都" } as never).select("id").single()).data!.id as string;
    await db1.from("stores").insert({ household_id: hid1, chain_id: chain, name: "テスト書店 港北店", prefecture: "神奈川県" } as never);
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  const snapshot = async () => JSON.stringify((await db1.from("stores").select("*").eq("household_id", hid1).order("name")).data);

  it("調査（モック）→ 検証 → 専用の表へ保存。店舗マスターは1文字も変わらない", async () => {
    const t = await loadStoreTarget(db1, storeId);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.value.target.siblingNames).toEqual(["テスト書店 港北店"]); // 同じ系列の他店舗を読める
    const before = await snapshot();
    const out = await researchStoreLocation(t.value.target, t.value.existingAddress, { llm: new MockStoreBrain(t.value.target), search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: mockGeocode(EVAL_WORLD) });
    expect(out.result.status === "confirmed" || out.result.status === "candidate").toBe(true);
    const saved = await saveResearch(db1, storeId, t.value.target, out.result, out.run, out.engine, null);
    expect(saved.ok).toBe(true);
    expect(await snapshot()).toBe(before); // 店舗マスターは変更されていない（住所・座標・更新日時も）
    const rows = (await tbl(db1).select("*").eq("store_id", storeId)).data!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chain_name: "テスト書店", store_name: "テスト書店 駅前店", engine: "mock-brain" });
    expect(rows[0].address).toBe("東京都架空区駅前1-2-3");
    expect((rows[0].sources as unknown[]).length).toBeGreaterThan(0);
    expect(rows[0].usage).toMatchObject({ searches: expect.any(Number), costJpy: expect.any(Number) });
    expect((await listResearch(db1, storeId))[0].status).toBe(rows[0].status);
  });

  it("一覧: 実店舗が選べ、最新の調査状態が付く。実APIの実行回数は0（モックのみ）", async () => {
    const list = await listStoresForResearch(db1);
    const s = list.find((x) => x.id === storeId)!;
    expect(s.latest?.status).toBeTruthy();
    expect(list.find((x) => x.name === "テスト書店 港北店")!.latest).toBeNull();
    expect(await countRealRunsToday(db1)).toBe(0);
  });

  it("別の世帯からは見えない・書き込めない（RLS）", async () => {
    expect((await tbl(db2).select("id")).data).toEqual([]);
    const t = await loadStoreTarget(db2, storeId);
    expect(t.ok).toBe(false); // 他世帯の店舗は読めない
    const r = await tbl(db2).insert({ household_id: hid1, store_id: storeId, chain_name: "x", store_name: "y", status: "candidate", confidence: 10, engine: "mock" } as never);
    expect(r.error).not.toBeNull();
  });

  it("追記専用: 認証済みユーザーは更新・削除できない（履歴の改ざん防止）", async () => {
    const id = (await tbl(db1).select("id").eq("store_id", storeId).limit(1).single()).data!.id as string;
    const u = await tbl(db1).update({ address: "改ざん" } as never).eq("id", id);
    expect(u.error).not.toBeNull();
    const d = await tbl(db1).delete().eq("id", id);
    expect(d.error).not.toBeNull();
    expect((await tbl(db1).select("address").eq("id", id).single()).data!.address).toBe("東京都架空区駅前1-2-3");
  });

  it("不正な値（範囲外の信頼度・不正なステータス）はDBが拒否する", async () => {
    const base = { household_id: hid1, store_id: storeId, chain_name: "x", store_name: "y", engine: "mock" };
    expect((await tbl(db1).insert({ ...base, status: "confirmed", confidence: 101 } as never)).error).not.toBeNull();
    expect((await tbl(db1).insert({ ...base, status: "unknown_status", confidence: 5 } as never)).error).not.toBeNull();
    expect((await tbl(db1).insert({ ...base, status: "candidate", confidence: 5, latitude: 35.1 } as never)).error).not.toBeNull(); // 緯度だけ・経度なし
  });

  it("AIが作り話を提出しても検証で落ち、住所なしで保存される（住所が保存内容に入らない）", async () => {
    const t = await loadStoreTarget(db1, storeId);
    if (!t.ok) throw new Error("no target");
    const liar = {
      name: "liar",
      async step() {
        return { kind: "final" as const, output: { candidates: [{ address: "東京都架空区駅前9-9-9", sourceUrl: "https://test-bookstore.test/shops", quote: "テスト書店 駅前店　所在地：東京都架空区駅前9-9-9" }] }, usage: { inputTokens: 1, outputTokens: 1, costJpy: 0 } };
      },
    };
    const out = await researchStoreLocation(t.value.target, null, { llm: liar, search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: mockGeocode(EVAL_WORLD) });
    const saved = await saveResearch(db1, storeId, t.value.target, out.result, out.run, out.engine, null);
    expect(saved.ok).toBe(true);
    const row = (await tbl(db1).select("address,status").eq("engine", "liar").single()).data as unknown as { address: string | null; status: string };
    expect(row.address).toBeNull();
    expect(row.status).not.toBe("confirmed");
  });
});
