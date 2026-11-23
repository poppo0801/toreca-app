/**
 * Stage Collection-1 の結合テスト（実Supabase・RLS適用下）: 151図鑑・相場調査メモのテーブル制約、プロフィール別の分離、
 * 購入金額 null/0 の区別、入手方法と金額の整合（DB制約）、購入の二重登録防止、履歴の保持、世帯間の分離。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectedSet, sortPrices, zukanStats } from "@/lib/zukan/zukan";
import { toMarketPrice, toZukanCard, toZukanPrice } from "@/lib/zukan/rows";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い
type Db = any;
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage Collection-1: 151図鑑・相場調査メモ", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let hid2: string;
  let pA: string;
  let pB: string;
  let pOther: string;

  const ins = async (db: Db, table: string, row: Record<string, unknown>) => {
    const { data, error } = await db.from(table).insert(row).select("*").single();
    return { data: data as Record<string, unknown> | null, error };
  };
  const zc = (o: Record<string, unknown> = {}) => ({ household_id: hid, profile_id: pA, dex_no: 25, card_name: "ピカチュウ", acquire_method: "pack_opening", ...o });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "c1", 1);
    const b = await signInTestUser(admin, "c1", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    const profs = (await u1.from("profiles").select("id").order("sort_order")).data as { id: string }[];
    pA = profs[0].id;
    pB = profs[1].id;
    pOther = ((await u2.from("profiles").select("id").order("sort_order")).data as { id: string }[])[0].id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("151図鑑: 収集カードの登録。購入金額の null（未入力）と 0円 を区別して保存する。入手方法と金額の矛盾はDBも拒否する", async () => {
    const pack = await ins(u1, "zukan_cards", zc());
    expect(pack.error).toBeNull();
    expect(pack.data!.purchase_amount_yen).toBeNull(); // 未入力は null のまま
    const zero = await ins(u1, "zukan_cards", zc({ dex_no: 4, card_name: "ヒトカゲ", acquire_method: "single_purchase", purchase_amount_yen: 0 }));
    expect(zero.error).toBeNull();
    expect(zero.data!.purchase_amount_yen).toBe(0); // 明示的な0円
    const paid = await ins(u1, "zukan_cards", zc({ dex_no: 7, card_name: "ゼニガメ", acquire_method: "single_purchase", purchase_amount_yen: 300, quantity: 2 }));
    expect(paid.error).toBeNull();
    // 矛盾: 単品購入なのに金額なし／パック開封なのに金額あり
    expect((await ins(u1, "zukan_cards", zc({ acquire_method: "single_purchase", purchase_amount_yen: null }))).error).not.toBeNull();
    expect((await ins(u1, "zukan_cards", zc({ acquire_method: "pack_opening", purchase_amount_yen: 100 }))).error).not.toBeNull();
    // 範囲外・不正
    expect((await ins(u1, "zukan_cards", zc({ dex_no: 152 }))).error).not.toBeNull();
    expect((await ins(u1, "zukan_cards", zc({ dex_no: 0 }))).error).not.toBeNull();
    expect((await ins(u1, "zukan_cards", zc({ condition: "S" }))).error).not.toBeNull();
    expect((await ins(u1, "zukan_cards", zc({ quantity: 0 }))).error).not.toBeNull();
  });

  it("同じポケモンの複数カードは1匹として数え、単品購入金額の合計は金額ありのカードだけ（pack と 0円の区別）", async () => {
    await ins(u1, "zukan_cards", zc({ card_name: "ピカチュウV", set_name: "テスト弾", acquire_method: "single_purchase", purchase_amount_yen: 500 }));
    const rows = ((await u1.from("zukan_cards").select("*").eq("profile_id", pA)).data ?? []).map((r: Record<string, unknown>) => toZukanCard(r));
    expect(collectedSet(rows)).toEqual(new Set([25, 4, 7]));
    const s = zukanStats(rows);
    expect(s.collected).toBe(3);
    // ヒトカゲ0円 + ゼニガメ300円×2 + ピカチュウV 500円（パック開封のピカチュウは含めない）
    expect(s.singlePurchaseTotalYen).toBe(0 + 600 + 500);
    expect(s.cardCount).toBe(1 + 1 + 2 + 1);
  });

  it("プロフィール別の分離: 別のプロフィールの図鑑・価格調査は、プロフィールで絞ると見えない（同じ世帯でも）", async () => {
    await ins(u1, "zukan_cards", zc({ profile_id: pB, dex_no: 150, card_name: "ミュウツー" }));
    const a = (await u1.from("zukan_cards").select("dex_no").eq("profile_id", pA)).data as { dex_no: number }[];
    const b = (await u1.from("zukan_cards").select("dex_no").eq("profile_id", pB)).data as { dex_no: number }[];
    expect(a.map((r) => r.dex_no)).not.toContain(150);
    expect(b.map((r) => r.dex_no)).toEqual([150]);
    // 他の世帯のプロフィールには紐づけられない（複合外部キー）
    expect((await ins(u1, "zukan_cards", zc({ profile_id: pOther }))).error).not.toBeNull();
  });

  it("世帯間の分離（RLS）: 他の世帯の行は読めず、書き込めない", async () => {
    const seen = (await u2.from("zukan_cards").select("id")).data as { id: string }[];
    expect(seen).toHaveLength(0);
    const other = await ins(u2, "zukan_cards", { household_id: hid, profile_id: pA, dex_no: 1, card_name: "x", acquire_method: "pack_opening" });
    expect(other.error).not.toBeNull();
    const mine = await ins(u2, "zukan_cards", { household_id: hid2, profile_id: pOther, dex_no: 1, card_name: "フシギダネ", acquire_method: "pack_opening" });
    expect(mine.error).toBeNull();
    expect(((await u1.from("zukan_cards").select("id").eq("card_name", "フシギダネ")).data ?? []).length).toBe(0);
  });

  it("151図鑑の価格調査: 「この価格で購入」で収集カード（単品購入・金額・店舗・状態を引き継ぐ）を登録。同じ記録からの二重登録は拒否。購入後も価格の記録は残る", async () => {
    const rec = await ins(u1, "zukan_price_records", { household_id: hid, profile_id: pA, dex_no: 6, card_name: "リザードン", set_name: "テスト弾", card_number: "006/100", rarity: "SR", store_name: "テスト店", surveyed_on: "2026-11-10", condition: "A", price_yen: 1500 });
    expect(rec.error).toBeNull();
    const id = rec.data!.id as string;
    const buy = await u1.rpc("zukan_buy_from_price_tx", { p_price: id, p_acquired_on: "2026-11-11" });
    expect(buy.error).toBeNull();
    const card = toZukanCard(((await u1.from("zukan_cards").select("*").eq("id", buy.data as string).single()).data ?? {}) as Record<string, unknown>);
    expect(card).toMatchObject({ dexNo: 6, cardName: "リザードン", setName: "テスト弾", cardNumber: "006/100", rarity: "SR", acquireMethod: "single_purchase", purchaseAmountYen: 1500, storeName: "テスト店", condition: "A", quantity: 1, acquiredOn: "2026-11-11", priceRecordId: id });
    const again = await u1.rpc("zukan_buy_from_price_tx", { p_price: id, p_acquired_on: "2026-11-12" });
    expect(again.error?.code).toBe("23505");
    expect(((await u1.from("zukan_cards").select("id").eq("price_record_id", id)).data ?? []).length).toBe(1);
    // 購入後も価格の履歴は残る。価格記録を削除しても、購入した収集カードは残る（参照だけ外れる）
    expect(toZukanPrice(((await u1.from("zukan_price_records").select("*").eq("id", id).single()).data ?? {}) as Record<string, unknown>).priceYen).toBe(1500);
    expect((await u1.from("zukan_price_records").delete().eq("id", id)).error).toBeNull();
    const kept = (await u1.from("zukan_cards").select("price_record_id,purchase_amount_yen").eq("id", buy.data as string).single()).data as { price_record_id: string | null; purchase_amount_yen: number };
    expect(kept.price_record_id).toBeNull();
    expect(kept.purchase_amount_yen).toBe(1500);
    // 他の世帯の価格記録は購入できない
    const foreign = await ins(u2, "zukan_price_records", { household_id: hid2, profile_id: pOther, dex_no: 1, card_name: "フシギダネ", store_name: "他店", condition: "B", price_yen: 100 });
    expect((await u1.rpc("zukan_buy_from_price_tx", { p_price: foreign.data!.id as string, p_acquired_on: "2026-11-11" })).error).not.toBeNull();
    // 状態ランク・価格の制約
    expect((await ins(u1, "zukan_price_records", { household_id: hid, profile_id: pA, dex_no: 6, card_name: "x", store_name: "s", condition: "D", price_yen: 1 })).error).not.toBeNull();
    expect((await ins(u1, "zukan_price_records", { household_id: hid, profile_id: pA, dex_no: 6, card_name: "x", store_name: "s", condition: "A", price_yen: -1 })).error).not.toBeNull();
  });

  it("相場調査メモ: カードは識別情報（セット・番号・レアリティ）で一意。同じカードに複数店舗の価格を追加でき、並び替え・履歴が使える", async () => {
    const card = await ins(u1, "market_cards", { household_id: hid, profile_id: pA, name: "リザードンex", set_name: "スカーレットex", card_number: "006/078", rarity: "SR" });
    expect(card.error).toBeNull();
    const cid = card.data!.id as string;
    const dup = await ins(u1, "market_cards", { household_id: hid, profile_id: pA, name: "リザードンex（別名）", set_name: "スカーレットex", card_number: "006/078", rarity: "SR" });
    expect(dup.error?.code).toBe("23505"); // 同一カードは重複作成できない
    // 別のプロフィールも同じカードを重複して持てない（UI改修: 相場管理データは世帯の全員で共通。一意制約は世帯単位）
    expect((await ins(u1, "market_cards", { household_id: hid, profile_id: pB, name: "リザードンex", set_name: "スカーレットex", card_number: "006/078", rarity: "SR" })).error?.code).toBe("23505");
    // 番号が無いカードは識別の一意制約の対象外（名前だけで同一とみなさない・確認はアプリ側）
    expect((await ins(u1, "market_cards", { household_id: hid, profile_id: pA, name: "ピカチュウ" })).error).toBeNull();
    expect((await ins(u1, "market_cards", { household_id: hid, profile_id: pA, name: "ピカチュウ" })).error).toBeNull();
    const mk = (store: string, cond: string, price: number, day: string) => ins(u1, "market_prices", { household_id: hid, profile_id: pA, card_id: cid, store_name: store, surveyed_on: day, condition: cond, price_yen: price });
    const a = await mk("A店", "B", 800, "2026-11-01");
    await mk("B店", "A+", 1500, "2026-11-02");
    await mk("A店", "A", 1000, "2026-11-08"); // 同じ店舗の再調査（履歴として残る）
    await mk("C店", "A", 900, "2026-11-09");
    const prices = ((await u1.from("market_prices").select("*").eq("card_id", cid)).data ?? []).map((r: Record<string, unknown>) => toMarketPrice(r));
    expect(prices).toHaveLength(4);
    expect(sortPrices(prices, "condition").map((p) => `${p.condition}:${p.priceYen}`)).toEqual(["A+:1500", "A:900", "A:1000", "B:800"]);
    expect(sortPrices(prices, "price").map((p) => p.priceYen)).toEqual([800, 900, 1000, 1500]);
    expect(prices.filter((p: { storeName: string }) => p.storeName === "A店")).toHaveLength(2);
    // 価格の制約
    expect((await mk("X店", "Z", 1, "2026-11-09")).error).not.toBeNull();
    expect((await mk("X店", "A", -5, "2026-11-09")).error).not.toBeNull();
    expect((await mk("X店", "A", 0, "2026-11-09")).error).toBeNull(); // 0円は許す
    // 購入: 購入日・店舗・価格・状態を引き継ぐ。二重購入は拒否。購入後も価格・カードは残り、購入済みの価格記録・カードは削除できない
    const buy = await u1.rpc("market_buy_from_price_tx", { p_price: a.data!.id as string, p_purchased_on: "2026-11-10" });
    expect(buy.error).toBeNull();
    const pur = (await u1.from("market_purchases").select("*").eq("id", buy.data as string).single()).data as Record<string, unknown>;
    expect(pur).toMatchObject({ card_id: cid, price_id: a.data!.id, purchased_on: "2026-11-10", store_name: "A店", price_yen: 800, condition: "B" });
    expect((await u1.rpc("market_buy_from_price_tx", { p_price: a.data!.id as string, p_purchased_on: "2026-11-11" })).error?.code).toBe("23505");
    expect(((await u1.from("market_purchases").select("id").eq("price_id", a.data!.id as string)).data ?? []).length).toBe(1);
    expect((await u1.from("market_prices").delete().eq("id", a.data!.id as string)).error?.code).toBe("23503"); // 購入済みの価格記録は削除不可
    expect((await u1.from("market_cards").delete().eq("id", cid)).error?.code).toBe("23503"); // 履歴のあるカードは削除不可
    expect(((await u1.from("market_prices").select("id").eq("card_id", cid)).data ?? []).length).toBe(5);
  });

  it("相場調査メモ: 世帯間の分離。他の世帯のカード・価格は読めず、購入もできない。既存の購入記録・コレクションには書き込まれない", async () => {
    expect(((await u2.from("market_cards").select("id")).data ?? []).length).toBe(0);
    expect(((await u2.from("market_prices").select("id")).data ?? []).length).toBe(0);
    const anyPrice = (await u1.from("market_prices").select("id").limit(1)).data as { id: string }[];
    expect((await u2.rpc("market_buy_from_price_tx", { p_price: anyPrice[0].id, p_purchased_on: "2026-11-10" })).error).not.toBeNull();
    // 二重計上防止: 既存の購入記録・コレクションの表は、この機能では増えない
    expect(((await u1.from("purchases").select("id").eq("household_id", hid)).data ?? []).length).toBe(0);
    expect(((await u1.from("card_holdings").select("id").eq("household_id", hid)).data ?? []).length).toBe(0);
    expect(((await u1.from("card_masters").select("id").eq("household_id", hid)).data ?? []).length).toBe(0);
  });
});
