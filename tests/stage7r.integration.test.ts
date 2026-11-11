/**
 * Stage 7R: カードボックス（同名・別系列）の識別。実Supabase・RLS適用下・架空データのみ。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { reconcileAutoRegistered } from "@/lib/server/collector/dedupe-guard";
import { findDuplicates, matchChain } from "@/lib/lottery-match";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const ymd = (n: number) => new Date(NOW.getTime() + n * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
const BRAND = "7R箱屋";

describe.skipIf(!dbTestsEnabled)("Stage 7R: 同名の2系列（直営/その他）の識別", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db: Db;
  let hid: string;
  let direct: string;
  let other: string;
  let unk: string;
  let product: string;
  let sDirect: string;
  let sOther: string;

  const addLottery = async (chainId: string, storeId: string | null, deadline: string) => {
    const r = await db
      .from("lotteries")
      .insert({ household_id: hid, chain_id: chainId, store_id: storeId, store_mode: "fixed", apply_deadline_precision: "date_only", apply_deadline_date: deadline, receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "auto", source_urls: [`https://r.example.invalid/${Math.random().toString(36).slice(2)}`] } as never)
      .select("id")
      .single();
    expect(r.error).toBeNull();
    expect((await db.from("lottery_items").insert({ household_id: hid, lottery_id: r.data!.id, product_id: product, quantity: 1, unit: "box" } as never)).error).toBeNull();
    return r.data!.id as string;
  };
  const input = (chainId: string | null, storeId: string | null, deadline: string): LotteryInput =>
    ({ chain: { id: chainId, name: BRAND }, store: { id: storeId, name: "", prefecture: "" }, storeMode: "fixed", items: [{ product: { id: product, name: "7R商品" }, quantity: 1, unit: "box" }], applyStart: EMPTY_FLEX, applyDeadline: { precision: "date_only", date: deadline, time: "" }, sourceUrls: ["https://r.example.invalid/in"], multiMode: "single" }) as unknown as LotteryInput;
  const archived = async (id: string) => !!(await db.from("lotteries").select("archived_at").eq("id", id).single()).data?.archived_at;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7r", 1);
    userIds.push(a.userId);
    db = a.db;
    hid = (await db.rpc("bootstrap_household")).data as string;
    const mk = async (name: string, kind: string) =>
      (await db.from("chains").insert({ household_id: hid, name, brand_group: BRAND, operation_kind: kind } as never).select("id").single()).data!.id as string;
    direct = await mk(`${BRAND}（直営）`, "direct");
    other = await mk(`${BRAND}（その他）`, "other");
    unk = await mk(BRAND, "unconfirmed");
    product = (await db.from("products").insert({ household_id: hid, official_name: "7R商品", packs_per_box: 20 }).select("id").single()).data!.id;
    sDirect = (await db.from("stores").insert({ household_id: hid, chain_id: direct, name: "7R本店" }).select("id").single()).data!.id;
    sOther = (await db.from("stores").insert({ household_id: hid, chain_id: other, name: "7R支店" }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("アプリの読み込みで、直営・その他はどちらも同じ表示名。IDは別、所属未確認は区別される", async () => {
    const app = await loadAppData(db, hid);
    const c = (id: string) => app.chains.find((x) => x.id === id)!;
    expect(c(direct).name).toBe(BRAND);
    expect(c(other).name).toBe(BRAND);
    expect(c(direct).id).not.toBe(c(other).id);
    expect(c(unk).name).toBe(`${BRAND}（所属未確認）`);
  });

  it("店舗名から所属系列を判定する。不明な店舗は推測せず確認扱い（部分一致）", async () => {
    const app = await loadAppData(db, hid);
    expect(matchChain(BRAND, app.chains, { stores: app.stores, storeName: "7R本店" }).item?.id).toBe(direct);
    expect(matchChain(BRAND, app.chains, { stores: app.stores, storeName: "7R支店" }).item?.id).toBe(other);
    const o = matchChain(BRAND, app.chains, { stores: app.stores, storeName: "7R不明店" });
    expect(o.item?.id).toBe(other); // 直営の一覧に無い店舗は「その他」
    const u = matchChain(BRAND, app.chains, { stores: app.stores, storeName: "" });
    expect(u.kind).toBe("partial");
    expect(u.item?.id).toBe(unk);
  });

  it("同じ商品・同じ締切の抽選でも、直営と その他 は別カード（重複判定・登録直後の再確認のどちらでも統合されない）", async () => {
    const dl = ymd(14);
    const a = await addLottery(direct, null, dl);
    const b = await addLottery(other, null, dl);
    const app = await loadAppData(db, hid);
    const master = { chains: app.chains, stores: app.stores };
    const lots = app.lotteries.filter((l) => [a, b].includes(l.id));
    expect(findDuplicates(input(other, null, dl), lots.filter((l) => l.id === a), undefined, master, { now: NOW })).toEqual([]);
    expect(await reconcileAutoRegistered(db, hid, b, input(other, null, dl), master, { now: NOW })).toBeNull();
    expect(await reconcileAutoRegistered(db, hid, a, input(direct, null, dl), master, { now: NOW })).toBeNull();
    expect(await archived(a)).toBe(false);
    expect(await archived(b)).toBe(false);
  });

  it("同じ系列IDの同じ抽選は従来どおり統合される", async () => {
    product = (await db.from("products").insert({ household_id: hid, official_name: "7R商品2", packs_per_box: 20 }).select("id").single()).data!.id; // 前のテストの抽選と重ならない商品
    const dl = ymd(16);
    const first = await addLottery(direct, null, dl);
    const second = await addLottery(direct, null, ymd(18));
    const app = await loadAppData(db, hid);
    const r = await reconcileAutoRegistered(db, hid, second, input(direct, null, ymd(18)), { chains: app.chains, stores: app.stores }, { now: NOW });
    expect(r?.survivorId).toBe(first);
    expect(await archived(second)).toBe(true);
  });

  it("店舗と抽選の系列が一致している（店舗の系列IDと抽選の系列IDの整合）", async () => {
    const l = await addLottery(direct, sDirect, ymd(20));
    const row = (await db.from("lotteries").select("chain_id,store_id").eq("id", l).single()).data!;
    const st = (await db.from("stores").select("chain_id").eq("id", row.store_id!).single()).data!;
    expect(st.chain_id).toBe(row.chain_id);
    expect(sOther).toBeTruthy();
  });
});
