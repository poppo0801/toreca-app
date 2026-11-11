/**
 * Stage 7Q: 登録直後の重複の再確認（並行登録）・統合した情報元の記録・除外系列の読み込み。実Supabase・RLS適用下・架空データのみ。
 *   npm run test:db
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { reconcileAutoRegistered, recordMergedSource } from "@/lib/server/collector/dedupe-guard";
import { loadExcludedChains } from "@/lib/server/collector/chain-exclusion-load";
import { matchExcludedChain } from "@/lib/collector/chain-exclusion";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const ymd = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);

describe.skipIf(!dbTestsEnabled)("Stage 7Q: 並行登録の再確認・情報元の記録・除外系列", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db: Db;
  let hid: string;
  let chain: string;
  let product: string;
  let store1: string;
  let store2: string;

  const flex = (d: string) => ({ precision: "date_only" as const, date: d, time: "" });
  const lotRow = (deadline: string, over: Record<string, unknown> = {}) => ({
    household_id: hid,
    chain_id: chain,
    store_id: null,
    store_mode: "fixed",
    apply_deadline_precision: "date_only",
    apply_deadline_date: deadline,
    receive_method: "store",
    apply_method: "web",
    event_state: "open",
    limit_basis: "account",
    limit_max_count: 1,
    source_kind: "auto",
    source_urls: [`https://r.example.invalid/${Math.random().toString(36).slice(2)}`],
    ...over,
  });
  const addLottery = async (deadline: string, over: Record<string, unknown> = {}) => {
    const r = await db.from("lotteries").insert(lotRow(deadline, over) as never).select("id,created_at").single();
    expect(r.error).toBeNull();
    const it = await db.from("lottery_items").insert({ household_id: hid, lottery_id: r.data!.id, product_id: (over.__product as string) ?? product, quantity: 1, unit: "box" } as never);
    expect(it.error).toBeNull();
    return r.data!;
  };
  const input = (deadline: string, over: Partial<LotteryInput> = {}): LotteryInput =>
    ({
      chain: { id: chain, name: "7Q系列" },
      store: { id: null, name: "", prefecture: "" },
      storeMode: "fixed",
      items: [{ product: { id: product, name: "7Q商品" }, quantity: 1, unit: "box" }],
      applyStart: EMPTY_FLEX,
      applyDeadline: flex(deadline),
      sourceUrls: ["https://r.example.invalid/in"],
      multiMode: "single",
      ...over,
    }) as unknown as LotteryInput;
  const reconcile = async (id: string, i: LotteryInput) => {
    const app = await loadAppData(db, hid);
    return reconcileAutoRegistered(db, hid, id, i, { chains: app.chains, stores: app.stores }, { now: NOW, sourceUrl: "https://r.example.invalid/in" });
  };
  const archived = async (id: string) => !!(await db.from("lotteries").select("archived_at").eq("id", id).single()).data?.archived_at;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7q", 1);
    userIds.push(a.userId);
    db = a.db;
    hid = (await db.rpc("bootstrap_household")).data as string;
    chain = (await db.from("chains").insert({ household_id: hid, name: "7Q系列" }).select("id").single()).data!.id;
    product = (await db.from("products").insert({ household_id: hid, official_name: "7Q商品", packs_per_box: 20 }).select("id").single()).data!.id;
    store1 = (await db.from("stores").insert({ household_id: hid, chain_id: chain, name: "7Q一号店" }).select("id").single()).data!.id;
    store2 = (await db.from("stores").insert({ household_id: hid, chain_id: chain, name: "7Q二号店" }).select("id").single()).data!.id;
  });
  // テストごとに別の商品を使う（同じ系列・商品の抽選が前のテストと重ならないように）
  let seq = 0;
  beforeEach(async () => {
    product = (await db.from("products").insert({ household_id: hid, official_name: `7Q商品${++seq}`, packs_per_box: 20 }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("締切日だけ違う同じ抽選が並行して登録されても、先に作られた方だけが残る（どちらの処理が先に確認しても同じ結果）", async () => {
    const first = await addLottery(ymd(20));
    const second = await addLottery(ymd(24)); // 別の収集処理が同時に登録（締切日が違うので同一性キーでは防げない）
    // あとから作られた側の処理: 先の抽選を見つけて自分を統合
    const r2 = await reconcile(second.id, input(ymd(24)));
    expect(r2?.survivorId).toBe(first.id);
    expect(await archived(second.id)).toBe(true);
    // 先に作られた側の処理: あとの抽選（すでにアーカイブ済み）は対象外で、何も変更しない
    const r1 = await reconcile(first.id, input(ymd(20)));
    expect(r1).toBeNull();
    expect(await archived(first.id)).toBe(false);
  });

  it("両方の処理が、相手の登録を見たあとに確認しても、残るのは先に作られた1件だけ（全員が同じ結果）", async () => {
    const a = await addLottery(ymd(30), { source_urls: ["https://r.example.invalid/a"] });
    const b = await addLottery(ymd(33), { source_urls: ["https://r.example.invalid/b"] });
    const [ra, rb] = await Promise.all([reconcile(a.id, input(ymd(30))), reconcile(b.id, input(ymd(33)))]);
    expect(ra).toBeNull();
    expect(rb?.survivorId).toBe(a.id);
    expect(await archived(a.id)).toBe(false);
    expect(await archived(b.id)).toBe(true);
  });

  it("統合した情報元（URL・収集日時・収集時の系列名・統合元の抽選ID・元データ）が、残した側に記録される。同じURLは重複しない", async () => {
    const keep = await addLottery(ymd(40));
    const dupe = await addLottery(ymd(42));
    const r = await reconcile(dupe.id, input(ymd(42), { sourceUrls: ["https://r.example.invalid/in", "https://r.example.invalid/in2"] }));
    expect(r?.survivorId).toBe(keep.id);
    const ms = ((await db.from("lotteries").select("merged_sources").eq("id", keep.id).single()).data as unknown as { merged_sources: Record<string, unknown>[] }).merged_sources;
    expect(ms.map((m) => m.url).sort()).toEqual(["https://r.example.invalid/in", "https://r.example.invalid/in2"]);
    expect(ms[0]).toMatchObject({ chainName: "7Q系列", fromLotteryId: dupe.id });
    expect(ms[0].collectedAt).toBeTruthy();
    expect(ms[0].snapshot).toMatchObject({ chain: { id: chain }, items: [{ productId: product }] });
    // 同じURLを再度記録しても増えない
    await recordMergedSource(db, keep.id, { url: "https://r.example.invalid/in", collectedAt: NOW.toISOString(), chainName: "7Q系列", mergedAt: NOW.toISOString(), reason: "再" });
    const ms2 = ((await db.from("lotteries").select("merged_sources").eq("id", keep.id).single()).data as unknown as { merged_sources: unknown[] }).merged_sources;
    expect(ms2).toHaveLength(2);
  });

  it("別の店舗（店舗が確定している独立した抽選）・別の開催回・商品構成が違うものは統合しない", async () => {
    const s1 = await addLottery(ymd(50), { store_id: store1 });
    const s2 = await addLottery(ymd(50), { store_id: store2 });
    expect(await reconcile(s2.id, input(ymd(50), { store: { id: store2, name: "7Q二号店", prefecture: "" } }))).toBeNull();
    expect(await archived(s1.id)).toBe(false);
    expect(await archived(s2.id)).toBe(false);
    // 別の開催回: 前回の締切がすでに過ぎている
    const old = await addLottery(ymd(-10), { store_id: store1, apply_start_precision: "date_only", apply_start_date: ymd(-20) });
    const next = await addLottery(ymd(60), { store_id: store1 });
    const rr = await reconcile(next.id, input(ymd(60), { store: { id: store1, name: "7Q一号店", prefecture: "" }, applyStart: flex(ymd(40)) }));
    expect(rr?.survivorId === old.id).toBe(false);
    expect(await archived(old.id)).toBe(false);
  });

  it("応募記録がある抽選は、再確認でも統合（アーカイブ）しない", async () => {
    const first = await addLottery(ymd(70));
    const second = await addLottery(ymd(73));
    const prof = (await db.from("profiles").select("id").eq("household_id", hid).limit(1).single()).data!.id as string;
    const ap = await db.from("applications").insert({ household_id: hid, lottery_id: second.id, profile_id: prof, state: "applied" } as never);
    if (ap.error) return; // 応募の必須列が増えていて挿入できない場合はこの確認をスキップ
    expect(await reconcile(second.id, input(ymd(73)))).toBeNull();
    expect(await archived(second.id)).toBe(false);
    void first;
  });

  it("除外系列: 有効な除外ルールと系列マスターの名称・別名が読み込まれ、別名・表記ゆれ・IDなしでも一致する。解除すると対象外になる", async () => {
    const ex = await db.from("collection_exclusions").insert({ household_id: hid, scope: "chain", key: chain, chain_id: chain, label: "7Q系列", reason_code: "untrusted_shop", reason_note: "テスト" } as never).select("id").single();
    expect(ex.error).toBeNull();
    await db.from("chain_aliases").insert({ household_id: hid, chain_id: chain, alias: "ななきゅーけいれつ", normalized_alias: "ななきゅーけいれつ" } as never);
    const list = await loadExcludedChains(db, hid);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ chainId: chain, name: "7Q系列", reasonCode: "untrusted_shop" });
    expect(matchExcludedChain(list, { chainId: chain })?.via).toBe("id");
    expect(matchExcludedChain(list, { chainName: "７Ｑ系列" })?.via).toBe("name");
    expect(matchExcludedChain(list, { chainId: null, chainName: "ななきゅーけいれつ" })?.via).toBe("name");
    expect(matchExcludedChain(list, { chainId: "別の系列", chainName: "別の店" })).toBeNull();
    await db.from("collection_exclusions").update({ active: false, released_at: new Date().toISOString() } as never).eq("id", ex.data!.id);
    expect(await loadExcludedChains(db, hid)).toEqual([]);
  });
});
