/**
 * Stage 5F の結合テスト（実Supabase・RLS適用下）: カードマスター・所有記録・参考相場・お気に入り・画像ストレージの認可、購入記録の保護。
 *   npm run test:db   ※ マイグレーション 20261030000025/26 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addManualPurchase, loadAppData, type Db } from "@/lib/server/lottery-service";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");

describe.skipIf(!dbTestsEnabled)("Stage 5F: コレクション", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let hid2: string;
  let a1: string;
  let b1: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
  const x = (db: Db) => db as any;
  const save = (db: Db, p: Record<string, unknown>, actor: string | null = a1) => x(db).rpc("save_card_with_holding", { p, p_actor: actor });
  const pika = { name: "ピカチュウex", card_number: "201/165", set_code: "sv2a", rarity: "SAR" };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5f", 1);
    const b = await signInTestUser(admin, "s5f", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    const profs = (await u1.from("profiles").select("id,label")).data!;
    a1 = profs.find((p) => p.label === "A")!.id;
    b1 = profs.find((p) => p.label === "B")!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  let cardId: string;

  it("カードと最初の所有記録を1回で登録でき、同じ商品コード・番号・レアリティの二重登録は拒否される", async () => {
    const r = await save(u1, { card: pika, holding: { quantity: 1, unit_price_yen: 15000, acquired_on: "2026-01-10" } });
    expect(r.error).toBeNull();
    cardId = r.data as string;
    const dup = await save(u1, { card: pika, holding: { quantity: 1 } });
    expect(dup.error?.code).toBe("23505");
    // 失敗した登録ではカードも所有記録も残らない（原子的）
    expect((await x(u1).from("card_masters").select("id").eq("name", "ピカチュウex")).data).toHaveLength(1);
    expect((await x(u1).from("card_holdings").select("id").eq("card_id", cardId)).data).toHaveLength(1);
    // 同名でも番号・レアリティが違えば別のカード
    expect((await save(u1, { card: { ...pika, card_number: "132/165", rarity: "RR" }, holding: null })).error).toBeNull();
    // 番号なしのカードは重複制約の対象外（名称だけでは同一と見なさない）
    expect((await save(u1, { card: { name: "番号なし" }, holding: null })).error).toBeNull();
    expect((await save(u1, { card: { name: "番号なし" }, holding: null })).error).toBeNull();
  });

  it("同じカードに、異なる価格・日付の所有記録を追加できる（購入履歴が保持され、合算は画面側）", async () => {
    expect((await save(u1, { card_id: cardId, holding: { quantity: 1, unit_price_yen: 18000, acquired_on: "2026-02-10", source: "店A" } })).error).toBeNull();
    expect((await save(u1, { card_id: cardId, holding: { quantity: 1, unit_price_yen: 20000, acquired_on: "2026-03-10" } })).error).toBeNull();
    const hs = (await x(u1).from("card_holdings").select("quantity,unit_price_yen").eq("card_id", cardId).order("acquired_on")).data;
    expect(hs.map((h: { unit_price_yen: number }) => h.unit_price_yen)).toEqual([15000, 18000, 20000]);
    // 不正な値は拒否（枚数0・負の金額）
    expect((await save(u1, { card_id: cardId, holding: { quantity: 0 } })).error).not.toBeNull();
    expect((await save(u1, { card_id: cardId, holding: { quantity: 1, unit_price_yen: -5 } })).error).not.toBeNull();
    // 金額不明は NULL のまま（0円にならない）
    expect((await save(u1, { card_id: cardId, holding: { quantity: 1 } })).error).toBeNull();
    expect((await x(u1).from("card_holdings").select("unit_price_yen").eq("card_id", cardId).is("unit_price_yen", null)).data).toHaveLength(1);
  });

  it("他世帯のカードには所有記録を追加できない。他世帯からは一覧に見えない", async () => {
    expect((await save(u2, { card_id: cardId, holding: { quantity: 1 } }, null)).error).not.toBeNull();
    expect((await x(u2).from("card_masters").select("id")).data ?? []).toHaveLength(0);
    expect((await x(u2).from("card_holdings").select("id")).data ?? []).toHaveLength(0);
    // 世帯IDを偽った直接の挿入も不可
    expect((await x(u2).from("card_masters").insert({ household_id: hid1, name: "不正" })).error).not.toBeNull();
    expect((await x(u2).from("card_holdings").insert({ household_id: hid1, card_id: cardId, quantity: 1 })).error).not.toBeNull();
    // 未ログイン
    expect((await x(anonClient() as unknown as Db).from("card_masters").select("id")).data ?? []).toHaveLength(0);
    expect((await save(anonClient() as unknown as Db, { card: { name: "x" }, holding: null }, null)).error).not.toBeNull();
  });

  it("参考相場は追記専用（更新・削除できない）。販売と買取を区別し、価格は0円以上", async () => {
    const put = (kind: string, amount: number) => x(u1).from("card_prices").insert({ household_id: hid1, card_id: cardId, kind, amount_yen: amount, confirmed_on: "2026-10-29", source: "テスト店" });
    expect((await put("sale", 33000)).error).toBeNull();
    expect((await put("buyback", 25000)).error).toBeNull();
    expect((await put("other", 1)).error).not.toBeNull();
    expect((await put("sale", -1)).error).not.toBeNull();
    const row = (await x(u1).from("card_prices").select("id").eq("kind", "sale").single()).data;
    expect((await x(u1).from("card_prices").update({ amount_yen: 1 }).eq("id", row.id).select()).data ?? []).toHaveLength(0);
    expect((await x(u1).from("card_prices").delete().eq("id", row.id).select()).data ?? []).toHaveLength(0);
    expect((await x(u2).from("card_prices").select("id")).data ?? []).toHaveLength(0);
  });

  it("お気に入りはプロフィールごと・順位つき。同じカードを二重に登録できず、他世帯のカード・プロフィールは不可", async () => {
    const fav = (db: Db, hid: string, pid: string, cid: string, rank = 0) => x(db).from("card_favorites").insert({ household_id: hid, profile_id: pid, card_id: cid, rank });
    expect((await fav(u1, hid1, a1, cardId, 0)).error).toBeNull();
    expect((await fav(u1, hid1, a1, cardId, 1)).error).not.toBeNull(); // 二重
    expect((await fav(u1, hid1, b1, cardId, 0)).error).toBeNull(); // Bは独立
    const mine = (await x(u1).from("card_favorites").select("profile_id").eq("profile_id", a1)).data;
    expect(mine).toHaveLength(1);
    // 順位の更新・解除
    expect((await x(u1).from("card_favorites").update({ rank: 5 }).eq("profile_id", a1).eq("card_id", cardId)).error).toBeNull();
    expect((await x(u1).from("card_favorites").select("rank").eq("profile_id", a1).single()).data.rank).toBe(5);
    expect((await x(u1).from("card_favorites").select("rank").eq("profile_id", b1).single()).data.rank).toBe(0); // Bは変わらない
    // 他世帯
    const a2 = (await u2.from("profiles").select("id").limit(1)).data![0].id;
    expect((await fav(u2, hid2, a2, cardId)).error).not.toBeNull(); // 他世帯のカード
    expect((await fav(u1, hid1, a2, cardId)).error).not.toBeNull(); // 他世帯のプロフィール
    expect((await x(u2).from("card_favorites").select("id")).data ?? []).toHaveLength(0);
    expect((await x(u1).from("card_favorites").delete().eq("profile_id", b1).eq("card_id", cardId)).error).toBeNull();
  });

  it("カードの削除（アーカイブ）で、関連する購入記録は消えない。所有記録から購入記録を参照できる", async () => {
    const chain = (await u1.from("chains").insert({ household_id: hid1, name: "5F系列" }).select("id").single()).data!.id;
    const store = (await u1.from("stores").insert({ household_id: hid1, chain_id: chain, name: "5F店" }).select("id").single()).data!.id;
    const prod = (await u1.from("products").insert({ household_id: hid1, official_name: "5Fテスト単品" }).select("id").single()).data!.id;
    const res = await addManualPurchase(u1, hid1, { storeId: store, date: "2026-10-01", time: "", channel: "store", note: "", items: [{ productId: prod, quantity: 1, unit: "set", amountPaid: 5000 }] }, a1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const pid = res.value.id;
    const r = await save(u1, { card: { name: "購入連携カード", card_number: "1/1", set_code: "x", rarity: "SR" }, holding: { quantity: 1, unit_price_yen: 5000, purchase_id: pid } });
    expect(r.error).toBeNull();
    const cid = r.data as string;
    // 他世帯の購入記録は参照できない
    expect((await save(u2, { card: { name: "他世帯" }, holding: { quantity: 1, purchase_id: pid } }, null)).error).not.toBeNull();
    const before = await loadAppData(u1);
    await x(u1).from("card_holdings").update({ archived_at: new Date().toISOString() }).eq("card_id", cid);
    await x(u1).from("card_masters").update({ archived_at: new Date().toISOString() }).eq("id", cid);
    const after = await loadAppData(u1);
    expect(after.purchases.map((p) => p.id)).toContain(pid); // 購入記録は残る
    expect(after.purchases).toHaveLength(before.purchases.length);
    // アーカイブ後は同じ番号で登録し直せる（重複制約はアーカイブされていないカードだけが対象）
    expect((await save(u1, { card: { name: "購入連携カード", card_number: "1/1", set_code: "x", rarity: "SR" }, holding: null })).error).toBeNull();
  });

  it("カード画像のストレージは非公開で、自世帯のフォルダだけ読み書きできる（他世帯・不正なパスは不可）", async () => {
    const path = `${hid1}/test-main.webp`;
    expect((await u1.storage.from("card-images").upload(path, PNG, { contentType: "image/png" })).error).toBeNull();
    expect((await u1.storage.from("card-images").createSignedUrl(path, 60)).error).toBeNull();
    expect((await u2.storage.from("card-images").createSignedUrl(path, 60)).error).not.toBeNull();
    expect((await u2.storage.from("card-images").download(path)).error).not.toBeNull();
    expect((await u2.storage.from("card-images").upload(`${hid1}/evil.webp`, PNG, { contentType: "image/png" })).error).not.toBeNull();
    expect((await u1.storage.from("card-images").upload(`not-a-uuid/x.webp`, PNG, { contentType: "image/png" })).error).not.toBeNull();
    expect((await u1.storage.from("card-images").upload(`${hid1}/x.svg`, Buffer.from("<svg/>"), { contentType: "image/svg+xml" })).error).not.toBeNull(); // 形式制限
    expect((await anonClient().storage.from("card-images").download(path)).error).not.toBeNull();
    expect((await u2.storage.from("card-images").remove([path])).data ?? []).toHaveLength(0); // 他世帯は消せない
    expect((await u1.storage.from("card-images").remove([path])).error).toBeNull();
  });
});
