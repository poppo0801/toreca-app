/**
 * Stage 7M の結合テスト（実Supabase・RLS適用下・架空データのみ）:
 *  複数商品（商品ごとに当落）の抽選で、プロフィールごとに応募した商品を記録する。
 *   - 選んだ商品だけで応募でき、他のプロフィールの応募は変わらない
 *   - 応募商品の変更（当落が登録済みの商品は外せない／全商品を外すと応募取り消し）
 *   - 応募していない商品の当落は登録できない
 *   - 従来の記録（応募商品が未指定）は null のまま保持される（勝手に全商品と確定しない）
 *   npm run test:db   ※ マイグレーション 20261205000088 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { loadAppData, saveLottery, setAppliedItems, setApplied, setItemResults, type Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 7M: 商品別の応募", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db: Db;
  let hid: string;
  let profA: string;
  let profB: string;

  const ok = <T,>(r: { ok: boolean; value?: T; error?: string }) => {
    expect(r.ok, r.error).toBe(true);
    return (r as { value: T }).value;
  };
  const input = (over: Partial<LotteryInput> = {}): LotteryInput => ({
    chain: { id: null, name: "7M架空電機" },
    store: { id: null, name: "7M架空店", prefecture: "" },
    multiMode: "all",
    campaignId: null,
    newCampaign: null,
    items: [
      { product: { id: null, name: "7M商品A" }, quantity: 1, unit: "box" },
      { product: { id: null, name: "7M商品B" }, quantity: 1, unit: "box" },
    ],
    applyStart: EMPTY_FLEX,
    applyDeadline: EMPTY_FLEX,
    resultDate: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "store",
    applyMethod: "web",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "person",
    limitMaxCount: 1,
    memo: "",
    applications: [],
    appliedAt: "",
    ...over,
  });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7m", 1);
    userIds.push(a.userId);
    db = a.db;
    hid = (await db.rpc("bootstrap_household")).data as string;
    const profiles = (await db.from("profiles").select("id,label")).data!;
    profA = profiles.find((p) => p.label === "A")!.id;
    profB = profiles.find((p) => p.label === "B")!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  const accountOf = async (profileId: string, lotteryId: string) => {
    const d = await loadAppData(db);
    const chain = d.lotteries.find((l) => l.id === lotteryId)!.chainId;
    return d.accounts.find((a) => a.profileId === profileId && a.chainId === chain)!.id;
  };

  it("選んだ商品だけで応募し、プロフィールごとに独立して保持する（他のプロフィールの応募は変わらない）", async () => {
    const lot = ok(await saveLottery(db, hid, null, input(), profA)).id;
    let d = await loadAppData(db);
    const [a, b] = d.lotteries.find((l) => l.id === lot)!.items.map((i) => i.id!);
    ok(await setApplied(db, hid, lot, await accountOf(profA, lot), true, profA, null, { itemIds: [a] }));
    ok(await setApplied(db, hid, lot, await accountOf(profB, lot), true, profB, null, { itemIds: [b] }));
    d = await loadAppData(db);
    const apps = d.applications.filter((x) => x.lotteryId === lot);
    expect(apps).toHaveLength(2);
    expect(apps.find((x) => x.accountId === d.accounts.find((ac) => ac.profileId === profA && ac.chainId === d.lotteries.find((l) => l.id === lot)!.chainId)!.id)?.appliedItemIds).toEqual([a]);
    expect(apps.find((x) => x.accountId === d.accounts.find((ac) => ac.profileId === profB && ac.chainId === d.lotteries.find((l) => l.id === lot)!.chainId)!.id)?.appliedItemIds).toEqual([b]);
  });

  it("応募していない商品の当落は登録できない。応募した商品は登録できる", async () => {
    const lot = ok(await saveLottery(db, hid, null, input({ store: { id: null, name: "7M店2", prefecture: "" } }), profA)).id;
    let d = await loadAppData(db);
    const [a, b] = d.lotteries.find((l) => l.id === lot)!.items.map((i) => i.id!);
    ok(await setApplied(db, hid, lot, await accountOf(profA, lot), true, profA, null, { itemIds: [a] }));
    d = await loadAppData(db);
    const app = d.applications.find((x) => x.lotteryId === lot)!;
    expect((await setItemResults(db, app.id, [{ itemId: b, result: "won" }], profA)).ok).toBe(false);
    ok(await setItemResults(db, app.id, [{ itemId: a, result: "won" }], profA));
    d = await loadAppData(db);
    expect(d.applications.find((x) => x.id === app.id)).toMatchObject({ result: "won", itemResults: { [a]: "won" } });
  });

  it("応募した2商品のうち1商品だけ落選を登録しても全体は結果待ち。当選が出れば当選", async () => {
    const lot = ok(await saveLottery(db, hid, null, input({ store: { id: null, name: "7M店7", prefecture: "" } }), profA)).id;
    let d = await loadAppData(db);
    const [a, b] = d.lotteries.find((l) => l.id === lot)!.items.map((i) => i.id!);
    ok(await setApplied(db, hid, lot, await accountOf(profA, lot), true, profA, null, { itemIds: [a, b] }));
    d = await loadAppData(db);
    const app = d.applications.find((x) => x.lotteryId === lot)!;
    ok(await setItemResults(db, app.id, [{ itemId: a, result: "lost" }], profA));
    d = await loadAppData(db);
    expect(d.applications.find((x) => x.id === app.id)?.result).toBe("pending");
    ok(await setItemResults(db, app.id, [{ itemId: b, result: "won" }], profA));
    d = await loadAppData(db);
    expect(d.applications.find((x) => x.id === app.id)?.result).toBe("won");
  });

  it("応募商品の変更: 当落が登録済みの商品は外せない。追加はできる。全商品を外すと応募を取り消す", async () => {
    const lot = ok(await saveLottery(db, hid, null, input({ store: { id: null, name: "7M店3", prefecture: "" } }), profA)).id;
    let d = await loadAppData(db);
    const [a, b] = d.lotteries.find((l) => l.id === lot)!.items.map((i) => i.id!);
    ok(await setApplied(db, hid, lot, await accountOf(profA, lot), true, profA, null, { itemIds: [a] }));
    d = await loadAppData(db);
    const app = d.applications.find((x) => x.lotteryId === lot)!;
    ok(await setAppliedItems(db, app.id, [a, b], profA));
    ok(await setItemResults(db, app.id, [{ itemId: a, result: "lost" }], profA));
    // 当落が登録済みの a は外せない
    expect((await setAppliedItems(db, app.id, [b], profA)).ok).toBe(false);
    // 結果待ちの b は外せる
    ok(await setAppliedItems(db, app.id, [a], profA));
    d = await loadAppData(db);
    expect(d.applications.find((x) => x.id === app.id)).toMatchObject({ appliedItemIds: [a], state: "applied" });
    // 存在しない商品・別の抽選の商品は拒否
    expect((await setAppliedItems(db, app.id, ["00000000-0000-4000-8000-000000000001"], profA)).ok).toBe(false);
  });

  it("全商品を外すと応募を取り消す（応募済みタブから外れる）。結果待ちの商品だけなら取り消せる", async () => {
    const lot = ok(await saveLottery(db, hid, null, input({ store: { id: null, name: "7M店4", prefecture: "" } }), profA)).id;
    let d = await loadAppData(db);
    const [a] = d.lotteries.find((l) => l.id === lot)!.items.map((i) => i.id!);
    ok(await setApplied(db, hid, lot, await accountOf(profA, lot), true, profA, null, { itemIds: [a] }));
    d = await loadAppData(db);
    const app = d.applications.find((x) => x.lotteryId === lot)!;
    ok(await setAppliedItems(db, app.id, [], profA));
    d = await loadAppData(db);
    expect(d.applications.find((x) => x.id === app.id)?.state).toBe("cancelled");
    // 再度応募できる
    ok(await setApplied(db, hid, lot, await accountOf(profA, lot), true, profA, null, { itemIds: [a] }));
    d = await loadAppData(db);
    expect(d.applications.find((x) => x.id === app.id)).toMatchObject({ state: "applied", appliedItemIds: [a] });
  });

  it("商品を指定しない応募（従来の記録）は応募商品が null のまま。単一商品の抽選に商品指定は拒否", async () => {
    const lot = ok(await saveLottery(db, hid, null, input({ store: { id: null, name: "7M店5", prefecture: "" }, applications: [{ profileId: profA, status: "applied" }] }), profA)).id;
    let d = await loadAppData(db);
    expect(d.applications.find((x) => x.lotteryId === lot)?.appliedItemIds ?? null).toBeNull();
    const single = ok(await saveLottery(db, hid, null, input({ store: { id: null, name: "7M店6", prefecture: "" }, multiMode: "single", items: [{ product: { id: null, name: "7M単品" }, quantity: 1, unit: "box" }] }), profA)).id;
    d = await loadAppData(db);
    const it = d.lotteries.find((l) => l.id === single)!.items[0].id!;
    expect((await setApplied(db, hid, single, await accountOf(profA, single), true, profA, null, { itemIds: [it] })).ok).toBe(false);
  });
});
