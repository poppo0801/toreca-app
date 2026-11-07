/**
 * Stage 6L（単位・シュリンク目安・受取状態）の結合テスト（実Supabase・RLS適用下）。
 *   npm run test:db   ※ マイグレーション 20261123000067 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { loadBoxReceipts, recordBoxReceipt } from "@/lib/server/box-service";
import { loadAppData, saveLottery, type Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 6L: 商品区分・単位・シュリンク目安・受取状態", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let actor: string;
  let chainId: string;
  let storeId: string;
  let packId: string;
  let deckId: string;
  let purchaseId: string;
  let boxItem: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列は生成型に無い場合がある
  const x = (db: unknown) => db as any;

  const input = (productId: string, unit: "box" | "pack" | "set" | "piece", over: Partial<LotteryInput> = {}): LotteryInput => ({
    chain: { id: chainId, name: "" },
    store: { id: storeId, name: "", prefecture: "" },
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: productId, name: "" }, quantity: 2, unit }],
    applyStart: EMPTY_FLEX,
    applyDeadline: { precision: "date_only", date: "2099-12-31", time: "" },
    resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "store",
    applyMethod: "web",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "account",
    limitMaxCount: 1,
    memo: "",
    applications: [],
    ...over,
  });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6lu", 1);
    const b = await signInTestUser(admin, "s6lu", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    actor = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    chainId = (await u1.from("chains").insert({ household_id: hid, name: "6L単位テスト系列" }).select("id").single()).data!.id;
    storeId = (await u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "6L単位テスト店" }).select("id").single()).data!.id;
    packId = (await x(u1).from("products").insert({ household_id: hid, official_name: "6Lテスト拡張パック", packs_per_box: 30, product_kind: "expansion_pack" }).select("id").single()).data!.id;
    deckId = (await x(u1).from("products").insert({ household_id: hid, official_name: "6Lテストデッキ", product_kind: "deck" }).select("id").single()).data!.id;
    purchaseId = (await u1.from("purchases").insert({ household_id: hid, store_id: storeId, source_kind: "manual", purchased_at: new Date().toISOString(), updated_by_profile_id: actor }).select("id").single()).data!.id;
    boxItem = (await u1.from("purchase_items").insert({ household_id: hid, purchase_id: purchaseId, product_id: packId, quantity: 3, unit: "box", amount_paid: 16200 }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("商品区分・BOX販売形態の列は制約つき（未分類は NULL のまま、不正値は拒否）", async () => {
    const bad = await x(u1).from("products").insert({ household_id: hid, official_name: "6L不正区分", product_kind: "weird" });
    expect(bad.error).not.toBeNull();
    const badChain = await x(u1).from("chains").update({ box_shrink_hint: "weird" }).eq("id", chainId);
    expect(badChain.error).not.toBeNull();
    const okChain = await x(u1).from("chains").update({ box_shrink_hint: "shrink" }).eq("id", chainId);
    expect(okChain.error).toBeNull();
    const d = await loadAppData(u1);
    expect(d.chains.find((c) => c.id === chainId)?.boxShrinkHint).toBe("shrink");
    expect(d.products.find((p) => p.id === packId)?.productKind).toBe("expansion_pack");
    expect(d.products.find((p) => p.id === deckId)?.productKind).toBe("deck");
  });

  it("抽選の商品明細に「個」(piece) を保存できる。既存の BOX／セットの明細もそのまま保存・読込できる", async () => {
    const piece = await saveLottery(u1, hid, null, input(deckId, "piece"), actor);
    expect(piece.ok, JSON.stringify(piece)).toBe(true);
    const legacy = await saveLottery(u1, hid, null, input(deckId, "set"), actor);
    expect(legacy.ok, JSON.stringify(legacy)).toBe(true);
    const box = await saveLottery(u1, hid, null, input(packId, "box"), actor);
    expect(box.ok, JSON.stringify(box)).toBe(true);
    const d = await loadAppData(u1);
    const units = d.lotteries.flatMap((l) => l.items.map((i) => i.unit)).sort();
    expect(units).toEqual(["box", "piece", "set"]);
  });

  it("抽選ごとのBOX販売形態は系列の目安とは別に保持できる（系列の変更は過去の抽選・受取記録を変えない）", async () => {
    const lot = (await x(u1).from("lotteries").select("id").eq("household_id", hid).limit(1).single()).data.id;
    expect((await x(u1).from("lotteries").update({ box_shrink_hint: "no_shrink" }).eq("id", lot)).error).toBeNull();
    expect((await x(u1).from("chains").update({ box_shrink_hint: "pack_only" }).eq("id", chainId)).error).toBeNull();
    const d = await loadAppData(u1);
    expect(d.lotteries.find((l) => l.id === lot)?.boxShrinkHint).toBe("no_shrink");
    expect(d.chains.find((c) => c.id === chainId)?.boxShrinkHint).toBe("pack_only");
  });

  it("受取のシュリンク状態を、状態ごとの数量（混在）で系列・店舗・商品と関連づけて記録できる", async () => {
    const r = await recordBoxReceipt(u1, boxItem, "2026-11-07", [{ state: "shrink", quantity: 2 }, { state: "no_shrink", quantity: 1 }], actor);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const rows = (await x(u1).from("box_receipts").select("*").eq("purchase_item_id", boxItem)).data;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.chain_id).toBe(chainId);
      expect(row.store_id).toBe(storeId);
      expect(row.product_id).toBe(packId);
      expect(row.received_on).toBe("2026-11-07");
    }
    const loaded = await loadBoxReceipts(u1, [boxItem]);
    expect(loaded.ok && loaded.value.map((v) => `${v.state}:${v.quantity}`).sort()).toEqual(["no_shrink:1", "shrink:2"]);
  });

  it("同じ内容を何度保存しても増えず、内容を変えれば置き換わる。購入数量を超える記録は拒否", async () => {
    for (let i = 0; i < 3; i++) await recordBoxReceipt(u1, boxItem, "2026-11-07", [{ state: "shrink", quantity: 2 }, { state: "no_shrink", quantity: 1 }], actor);
    expect(((await x(u1).from("box_receipts").select("id").eq("purchase_item_id", boxItem)).data ?? []).length).toBe(2);
    const over = await recordBoxReceipt(u1, boxItem, "2026-11-07", [{ state: "shrink", quantity: 3 }, { state: "unknown", quantity: 1 }], actor);
    expect(over.ok).toBe(false);
    const rpcOver = await x(u1).rpc("record_box_receipt", { p_purchase_item_id: boxItem, p_actor: actor, p_received_on: "2026-11-07", p_states: [{ state: "shrink", quantity: 9 }] });
    expect(rpcOver.error).not.toBeNull();
    expect(((await x(u1).from("box_receipts").select("id").eq("purchase_item_id", boxItem)).data ?? []).length).toBe(2); // 失敗しても元の記録は残る
    const replace = await recordBoxReceipt(u1, boxItem, "2026-11-08", [{ state: "unknown", quantity: 1 }], actor);
    expect(replace.ok).toBe(true);
    const rows = (await x(u1).from("box_receipts").select("shrink_state,quantity").eq("purchase_item_id", boxItem)).data;
    expect(rows).toEqual([{ shrink_state: "unknown", quantity: 1 }]);
  });

  it("BOX以外の購入明細には記録できない。他の世帯の購入明細にも記録・参照できない", async () => {
    const packItem = (await u1.from("purchase_items").insert({ household_id: hid, purchase_id: purchaseId, product_id: packId, quantity: 5, unit: "pack" }).select("id").single()).data!.id;
    const notBox = await recordBoxReceipt(u1, packItem, "2026-11-07", [{ state: "shrink", quantity: 1 }], actor);
    expect(notBox.ok).toBe(false);
    const foreign = await recordBoxReceipt(u2, boxItem, "2026-11-07", [{ state: "shrink", quantity: 1 }], actor);
    expect(foreign.ok).toBe(false);
    const seen = (await x(u2).from("box_receipts").select("id")).data ?? [];
    expect(seen).toHaveLength(0);
  });

  it("購入明細を削除すると受取の記録も一緒に消える（孤立した記録を残さない）", async () => {
    await recordBoxReceipt(u1, boxItem, "2026-11-07", [{ state: "shrink", quantity: 1 }], actor);
    const it2 = (await u1.from("purchase_items").insert({ household_id: hid, purchase_id: purchaseId, product_id: packId, quantity: 1, unit: "box" }).select("id").single()).data!.id;
    await recordBoxReceipt(u1, it2, "2026-11-07", [{ state: "shrink", quantity: 1 }], actor);
    expect((await u1.from("purchase_items").delete().eq("id", it2)).error).toBeNull();
    expect(((await x(u1).from("box_receipts").select("id").eq("purchase_item_id", it2)).data ?? []).length).toBe(0);
  });
});
