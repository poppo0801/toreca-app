/**
 * Stage 7K の結合テスト（実Supabase・RLS適用下・架空データのみ）:
 * 開封記録（opening_records）の制約・世帯分離・冪等性（操作ID）・取り消し（非表示）・購入明細との関連・商品の統合/削除への追従。
 * BOX開封の実績は既存のBOX在庫の履歴から導出する（読み取りのみ。新しい支出は作らない）ことも確認する。
 *   npm run test:db   ※ マイグレーション 20261205000084 / 20261205000085 の適用後に実行する
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteProduct, mergeProducts } from "@/lib/server/product-merge-service";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 7K: 開封記録", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let h1: string;
  let actor: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に含まれない場合がある
  const x = (db: unknown) => db as any;
  const mkProduct = async (name: string, over: Record<string, unknown> = {}) => (await u1.from("products").insert({ household_id: h1, official_name: name, packs_per_box: 20, ...over } as never).select("id").single()).data!.id as string;
  const rec = (productId: string | null, over: Record<string, unknown> = {}) => ({ household_id: h1, product_id: productId, label: productId ? "" : "自由入力商品", quantity: 2, unit: "pack", opened_on: "2026-11-05", amount_yen: 300, profile_id: actor, ...over });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7k", 1);
    const b = await signInTestUser(admin, "s7k", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    h1 = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    actor = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
  });
  afterAll(async () => {
    const hs = (await admin.from("households").select("id").in("owner_auth_user_id", ids)).data ?? [];
    await admin.from("opening_records" as never).delete().in("household_id", hs.map((h) => h.id));
    await cleanupTestUsers(admin, ids);
  });

  it("制約: 数量1以上・単位はパック/セット/個（BOXは対象外）・金額は0以上（不明はNULL）・商品か名称が必要", async () => {
    const p = await mkProduct("7K商品A");
    expect((await x(u1).from("opening_records").insert(rec(p))).error).toBeNull();
    expect((await x(u1).from("opening_records").insert(rec(p, { quantity: 0 }))).error).not.toBeNull();
    expect((await x(u1).from("opening_records").insert(rec(p, { unit: "box" }))).error).not.toBeNull(); // BOXの開封はBOXコレクション
    expect((await x(u1).from("opening_records").insert(rec(p, { amount_yen: -1 }))).error).not.toBeNull();
    expect((await x(u1).from("opening_records").insert(rec(p, { amount_yen: null }))).error).toBeNull(); // 金額未設定は0円とは別
    expect((await x(u1).from("opening_records").insert(rec(null))).error).toBeNull(); // マスター未登録の名称
  });

  it("同じ操作ID（再送・二重タップ）では二重に登録されない", async () => {
    const p = await mkProduct("7K商品B");
    const op = randomUUID();
    expect((await x(u1).from("opening_records").insert(rec(p, { op_id: op }))).error).toBeNull();
    expect((await x(u1).from("opening_records").insert(rec(p, { op_id: op }))).error?.code).toBe("23505");
    expect((await x(u1).from("opening_records").select("id").eq("op_id", op)).data).toHaveLength(1);
  });

  it("取り消しは非表示（archived_at）。物理削除はできず、読み込みからは除かれる。購入(収支)は変わらない", async () => {
    const p = await mkProduct("7K商品C");
    const pu = (await u1.from("purchases").insert({ household_id: h1, source_kind: "manual", purchased_at: new Date().toISOString(), category: "pokemon_card" } as never).select("id").single()).data!.id as string;
    const item = (await u1.from("purchase_items").insert({ household_id: h1, purchase_id: pu, product_id: p, quantity: 5, unit: "pack", amount_paid: 750 } as never).select("id").single()).data!.id as string;
    const r = (await x(u1).from("opening_records").insert(rec(p, { purchase_item_id: item, quantity: 2, amount_yen: 300 })).select("id").single()).data.id as string;
    let app = await loadAppData(u1, h1);
    expect(app.openingRecords?.find((o) => o.id === r)).toMatchObject({ quantity: 2, amountYen: 300, purchaseItemId: item });
    expect((await x(u1).from("opening_records").delete().eq("id", r)).data ?? []).toHaveLength(0); // 利用者は削除できない
    expect((await x(u1).from("opening_records").update({ archived_at: new Date().toISOString() }).eq("id", r)).error).toBeNull();
    app = await loadAppData(u1, h1);
    expect(app.openingRecords?.find((o) => o.id === r)).toBeUndefined();
    // 購入明細・金額は変わらない
    expect((await u1.from("purchase_items").select("quantity,amount_paid").eq("id", item).single()).data).toMatchObject({ quantity: 5, amount_paid: 750 });
  });

  it("世帯の分離: 他の世帯の記録は読めず、作れず、変更できない", async () => {
    const p = await mkProduct("7K商品D");
    const r = (await x(u1).from("opening_records").insert(rec(p)).select("id").single()).data.id as string;
    expect((await x(u2).from("opening_records").select("id").eq("id", r)).data).toHaveLength(0);
    expect((await x(u2).from("opening_records").insert(rec(p))).error).not.toBeNull();
    await x(u2).from("opening_records").update({ quantity: 9 }).eq("id", r);
    expect((await x(u1).from("opening_records").select("quantity").eq("id", r).single()).data.quantity).toBe(2);
  });

  it("商品の統合: 開封記録は統合先へ付け替わる。参照のある商品は削除できない（履歴を残す）", async () => {
    const from = await mkProduct("7K統合元");
    const into = await mkProduct("7K統合先");
    const r = (await x(u1).from("opening_records").insert(rec(from)).select("id").single()).data.id as string;
    const del = await deleteProduct(u1, from);
    expect(del.ok).toBe(false); // 開封記録が参照している
    const m = await mergeProducts(u1, from, into, actor);
    expect(m.ok, JSON.stringify(m)).toBe(true);
    expect((await x(u1).from("opening_records").select("product_id").eq("id", r).single()).data.product_id).toBe(into);
    // 参照の無い商品は削除できる
    const free = await mkProduct("7K未使用");
    expect((await deleteProduct(u1, free)).ok).toBe(true);
  });

  it("BOXの開封実績は、既存のBOX在庫の履歴から導出される（取り消した開封は含まれない）。新しい支出は作られない", async () => {
    const p = await mkProduct("7K開封BOX", { packs_per_box: 30 });
    const expenseBefore = ((await u1.from("purchases").select("id")).data ?? []).length;
    // BOXの購入（収支）→ ロット自動作成 → 受取の状態は未確認(unknown)のまま開封
    const pu = (await u1.from("purchases").insert({ household_id: h1, source_kind: "manual", purchased_at: new Date().toISOString(), category: "pokemon_card" } as never).select("id").single()).data!.id as string;
    const item = (await u1.from("purchase_items").insert({ household_id: h1, purchase_id: pu, product_id: p, quantity: 3, unit: "box", amount_paid: 21600 } as never).select("id").single()).data!.id as string;
    const op = randomUUID();
    const open = await u1.rpc("box_open" as never, { p_household: h1, p_product: p, p_state: "unknown", p_qty: 1, p_actor: actor, p_op: op } as never);
    expect(open.error?.message).toBeUndefined();
    let app = await loadAppData(u1, h1);
    const mine = app.boxOpenings?.filter((o) => o.productId === p) ?? [];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ quantity: 1, unitPrice: 7200, profileId: actor, purchaseItemId: item });
    expect(app.boxLotItemIds).toContain(item);
    // 同じ操作の再送は二重にならない
    await u1.rpc("box_open" as never, { p_household: h1, p_product: p, p_state: "unknown", p_qty: 1, p_actor: actor, p_op: op } as never);
    app = await loadAppData(u1, h1);
    expect(app.boxOpenings?.filter((o) => o.productId === p)).toHaveLength(1);
    // 取り消し → 実績から除かれる
    expect((await u1.rpc("box_revert_op" as never, { p_household: h1, p_op: op, p_actor: actor } as never)).error?.message).toBeUndefined();
    app = await loadAppData(u1, h1);
    expect(app.boxOpenings?.filter((o) => o.productId === p)).toHaveLength(0);
    // 収支の購入は増減していない（開封・取り消しで支出を作らない）
    expect(((await u1.from("purchases").select("id")).data ?? []).length).toBe(expenseBefore + 1);
  });
});
