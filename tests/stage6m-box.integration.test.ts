/**
 * Stage 6M（BOXコレクション）の結合テスト（実Supabase・RLS適用下）。
 *   npm run test:db   ※ マイグレーション 20261124000068 の適用後に実行する
 * 在庫の履歴（購入・受取・売却・開封・手動調整）、二重計上の防止、同時操作、過去データの保護、世帯分離。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balancesOf, summarizeBoxes } from "@/lib/box-collection";
import { addBoxPrices, addManualBox, importPurchaseItem, loadBoxCollection, loadProductStock, openBoxes, revertBoxOp, saveBoxSettings } from "@/lib/server/box-collection-service";
import { recordBoxReceipt } from "@/lib/server/box-service";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 6M: BOXコレクションの在庫（履歴・連動・二重計上防止）", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let hid2: string;
  let actor: string;
  let storeId: string;
  let prodA: string;
  let prodB: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
  const x = (db: unknown) => db as any;
  const today = new Date().toISOString().slice(0, 10);

  /** 商品の状態別の所有数（履歴の合計） */
  const stock = async (db: Db, productId: string) => {
    const r = await loadProductStock(db, productId);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const newPurchase = async (productId: string, quantity: number, amount: number | null, unit = "box") => {
    const p = (await u1.from("purchases").insert({ household_id: hid, store_id: storeId, source_kind: "manual", purchased_at: new Date().toISOString(), updated_by_profile_id: actor }).select("id").single()).data!.id;
    const item = (await u1.from("purchase_items").insert({ household_id: hid, purchase_id: p, product_id: productId, quantity, unit, amount_paid: amount }).select("id").single()).data!.id;
    return { purchaseId: p as string, itemId: item as string };
  };
  const lotOf = async (itemId: string) => (await x(u1).from("box_lots").select("*").eq("purchase_item_id", itemId).maybeSingle()).data;
  const sell = (productId: string, quantity: number, state: string | null) =>
    u1.from("sales").insert({ household_id: hid, sold_on: today, platform: "テスト", product_id: productId, quantity, unit: "box", amount: 1000, seller_profile_id: actor, ...(state ? { box_state: state } : {}) } as never).select("id").single();

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6m", 1);
    const b = await signInTestUser(admin, "s6m", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    actor = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    const chain = (await u1.from("chains").insert({ household_id: hid, name: "6M系列" }).select("id").single()).data!.id;
    storeId = (await u1.from("stores").insert({ household_id: hid, chain_id: chain, name: "6M店" }).select("id").single()).data!.id;
    prodA = (await u1.from("products").insert({ household_id: hid, official_name: "6Mテラスタルフェスex", packs_per_box: 10, release_date: "2024-12-06" }).select("id").single()).data!.id;
    prodB = (await u1.from("products").insert({ household_id: hid, official_name: "6Mステラミラクル", packs_per_box: 30 }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("手動登録: ロットと履歴ができ、同じ操作IDの再送では二重に登録されない", async () => {
    const op = randomUUID();
    const input = { productId: prodA, state: "shrink" as const, quantity: 2, acquiredOn: "2026-10-01", storeLabel: "手動店", actualUnitPrice: 5400, marketUnitPrice: 12000, marketPriceSource: "テスト相場表", marketPriceDate: "2026-10-01", note: "", opId: op };
    const r1 = await addManualBox(u1, hid, input, actor);
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    const r2 = await addManualBox(u1, hid, input, actor); // 再送
    expect(r2.ok).toBe(true);
    expect((await stock(u1, prodA)).shrink).toBe(2);
    expect(((await x(u1).from("box_lots").select("id").eq("product_id", prodA).eq("source_kind", "manual")).data ?? []).length).toBe(1);
    // 購入時点の市場相場は取得元・基準日とセット（出所の分からない価格は拒否）
    const bad = await addManualBox(u1, hid, { ...input, opId: randomUUID(), marketPriceSource: "" }, actor);
    expect(bad.ok).toBe(false);
    // 集計: 購入=市場相場12,000×2、実購入5,400は別
    const c = await loadBoxCollection(u1);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const row = summarizeBoxes(c.value.products, c.value.lots, balancesOf(c.value.movements), c.value.prices, c.value.settings).find((r) => r.productId === prodA)!;
    expect(row.purchaseTotal).toBe(24000);
    expect(row.buybackTotal).toBeNull(); // 相場は未取得
  });

  it("購入記録と連動: BOXの購入で所有数が増え、再保存では増えず、編集は差分だけ、パック購入は対象外", async () => {
    const before = (await stock(u1, prodB)).unknown;
    const { purchaseId, itemId } = await newPurchase(prodB, 2, 10800);
    let lot = await lotOf(itemId);
    expect(lot.source_kind).toBe("purchase");
    expect(lot.actual_unit_price).toBe(5400);
    expect((await stock(u1, prodB)).unknown).toBe(before + 2);
    // 同じ内容の再保存（更新）で二重に増えない
    for (let i = 0; i < 3; i++) await u1.from("purchase_items").update({ quantity: 2, amount_paid: 10800 }).eq("id", itemId);
    expect((await stock(u1, prodB)).unknown).toBe(before + 2);
    // 数量の編集は差分だけ
    await u1.from("purchase_items").update({ quantity: 5 }).eq("id", itemId);
    expect((await stock(u1, prodB)).unknown).toBe(before + 5);
    await u1.from("purchase_items").update({ quantity: 1 }).eq("id", itemId);
    expect((await stock(u1, prodB)).unknown).toBe(before + 1);
    // 単位をパックに直せば対象外（0に戻る）
    await u1.from("purchase_items").update({ unit: "pack" }).eq("id", itemId);
    expect((await stock(u1, prodB)).unknown).toBe(before);
    await u1.from("purchase_items").update({ unit: "box", quantity: 2 }).eq("id", itemId);
    expect((await stock(u1, prodB)).unknown).toBe(before + 2);
    // パック購入は加算しない
    const pack = await newPurchase(prodB, 10, 5000, "pack");
    expect(await lotOf(pack.itemId)).toBeNull();
    expect((await stock(u1, prodB)).unknown).toBe(before + 2);
    // 購入記録の削除（archived_at）で戻り、復元で戻る
    await u1.from("purchases").update({ archived_at: new Date().toISOString() }).eq("id", purchaseId);
    expect((await stock(u1, prodB)).unknown).toBe(before);
    await u1.from("purchases").update({ archived_at: null }).eq("id", purchaseId);
    expect((await stock(u1, prodB)).unknown).toBe(before + 2);
    // 明細の削除でも戻る。ロットは購入明細から切り離される（履歴は残る）
    expect((await u1.from("purchase_items").delete().eq("id", itemId)).error).toBeNull();
    expect((await stock(u1, prodB)).unknown).toBe(before);
    lot = (await x(u1).from("box_lots").select("*").eq("id", lot.id).single()).data;
    expect(lot.purchase_item_id).toBeNull();
    expect(lot.archived_at).not.toBeNull();
  });

  it("受取と連動: 状態が未確認から実際の状態へ移る（購入と受取で二重加算しない。混在も数量が一致）", async () => {
    const before = await stock(u1, prodA);
    const { itemId } = await newPurchase(prodA, 3, 16200);
    expect((await stock(u1, prodA)).unknown).toBe(before.unknown + 3);
    const r1 = await recordBoxReceipt(u1, itemId, today, [{ state: "shrink", quantity: 2 }, { state: "no_shrink", quantity: 1 }], actor);
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    let s = await stock(u1, prodA);
    expect([s.shrink - before.shrink, s.no_shrink - before.no_shrink, s.unknown - before.unknown]).toEqual([2, 1, 0]);
    // 同じ記録を何度保存しても変わらない
    for (let i = 0; i < 3; i++) await recordBoxReceipt(u1, itemId, today, [{ state: "shrink", quantity: 2 }, { state: "no_shrink", quantity: 1 }], actor);
    s = await stock(u1, prodA);
    expect([s.shrink - before.shrink, s.no_shrink - before.no_shrink, s.unknown - before.unknown]).toEqual([2, 1, 0]);
    // 一部だけ受け取った場合: 残りは未確認のまま
    await recordBoxReceipt(u1, itemId, today, [{ state: "no_shrink", quantity: 1 }], actor);
    s = await stock(u1, prodA);
    expect([s.shrink - before.shrink, s.no_shrink - before.no_shrink, s.unknown - before.unknown]).toEqual([0, 1, 2]);
    // 購入数量の減少に追従（受取の合計が購入数量を超えない）
    await u1.from("purchase_items").update({ quantity: 1 }).eq("id", itemId);
    s = await stock(u1, prodA);
    expect([s.shrink - before.shrink, s.no_shrink - before.no_shrink, s.unknown - before.unknown]).toEqual([0, 1, 0]);
  });

  it("売却と連動: 状態と数量を指定して所有数が減り、編集・削除で整合し、所有数を超える売却は拒否される", async () => {
    await addManualBox(u1, hid, { productId: prodB, state: "shrink", quantity: 3, acquiredOn: "2026-09-01", storeLabel: "", actualUnitPrice: null, marketUnitPrice: null, marketPriceSource: "", marketPriceDate: null, note: "", opId: randomUUID() }, actor);
    const base = (await stock(u1, prodB)).shrink;
    const sold = await sell(prodB, 1, "shrink");
    expect(sold.error, JSON.stringify(sold.error)).toBeNull();
    const saleId = sold.data!.id as string;
    expect((await stock(u1, prodB)).shrink).toBe(base - 1);
    // 同じ内容の再保存では変わらない
    await u1.from("sales").update({ memo: "再保存" }).eq("id", saleId);
    expect((await stock(u1, prodB)).shrink).toBe(base - 1);
    // 数量の編集
    await u1.from("sales").update({ quantity: 3 }).eq("id", saleId);
    expect((await stock(u1, prodB)).shrink).toBe(base - 3);
    // 所有数を超える編集は拒否され、元のまま
    const over = await u1.from("sales").update({ quantity: base + 5 }).eq("id", saleId);
    expect(over.error?.message).toContain("insufficient box stock");
    expect((await stock(u1, prodB)).shrink).toBe(base - 3);
    // 所有数を超える新規の売却は拒否され、売却の記録も作られない
    const count = ((await u1.from("sales").select("id").eq("household_id", hid)).data ?? []).length;
    const overNew = await sell(prodB, base + 5, "shrink");
    expect(overNew.error?.message).toContain("insufficient box stock");
    expect(((await u1.from("sales").select("id").eq("household_id", hid)).data ?? []).length).toBe(count);
    // 状態を指定しない売却は在庫に反映しない
    const none = await sell(prodB, 1, null);
    expect(none.error).toBeNull();
    expect((await stock(u1, prodB)).shrink).toBe(base - 3);
    // 売却の削除（archived_at）で在庫が戻る。購入ロットの履歴は残る
    await u1.from("sales").update({ archived_at: new Date().toISOString() }).eq("id", saleId);
    expect((await stock(u1, prodB)).shrink).toBe(base);
  });

  it("開封: 所有数が減る（売却とは別）。同じ操作の再送は1度だけ、取り消しで戻り、取り消しも1度だけ", async () => {
    const base = (await stock(u1, prodB)).shrink;
    const op = randomUUID();
    const o1 = await openBoxes(u1, hid, { productId: prodB, state: "shrink", quantity: 2, opId: op }, actor);
    expect(o1.ok, JSON.stringify(o1)).toBe(true);
    await openBoxes(u1, hid, { productId: prodB, state: "shrink", quantity: 2, opId: op }, actor); // 再送
    expect((await stock(u1, prodB)).shrink).toBe(base - 2);
    expect((await revertBoxOp(u1, hid, op, actor)).ok).toBe(true);
    expect((await stock(u1, prodB)).shrink).toBe(base);
    expect((await revertBoxOp(u1, hid, op, actor)).ok).toBe(true); // 2度目は何もしない
    expect((await stock(u1, prodB)).shrink).toBe(base);
    // 所有数を超える開封は拒否
    const over = await openBoxes(u1, hid, { productId: prodB, state: "shrink", quantity: base + 1, opId: randomUUID() }, actor);
    expect(over.ok).toBe(false);
    expect((await stock(u1, prodB)).shrink).toBe(base);
    // 開封の履歴が残る
    const hist = (await x(u1).from("box_movements").select("kind,qty,op_id").eq("op_id", op)).data;
    expect(hist).toEqual([{ kind: "open", qty: -2, op_id: op }]);
  });

  it("同時操作: 在庫を超える開封を並行して送っても、所有数分だけ成功し、負にならない。同じ操作の並行送信は1度だけ", async () => {
    await addManualBox(u1, hid, { productId: prodA, state: "unknown", quantity: 3, acquiredOn: null, storeLabel: "", actualUnitPrice: null, marketUnitPrice: null, marketPriceSource: "", marketPriceDate: null, note: "", opId: randomUUID() }, actor);
    const before = (await stock(u1, prodA)).unknown;
    const results = await Promise.all(Array.from({ length: before + 3 }, () => openBoxes(u1, hid, { productId: prodA, state: "unknown", quantity: 1, opId: randomUUID() }, actor)));
    expect(results.filter((r) => r.ok).length).toBe(before);
    expect((await stock(u1, prodA)).unknown).toBe(0);
    // 同じ操作IDを並行して送る
    await addManualBox(u1, hid, { productId: prodA, state: "unknown", quantity: 5, acquiredOn: null, storeLabel: "", actualUnitPrice: null, marketUnitPrice: null, marketPriceSource: "", marketPriceDate: null, note: "", opId: randomUUID() }, actor);
    const same = randomUUID();
    await Promise.all(Array.from({ length: 4 }, () => openBoxes(u1, hid, { productId: prodA, state: "unknown", quantity: 1, opId: same }, actor)));
    expect((await stock(u1, prodA)).unknown).toBe(4);
  });

  it("過去データの保護: 適用時刻より前の購入記録は自動で入らず、手動の取り込みでだけ入る（取り込みは1度だけ）", async () => {
    // この世帯の「自動連動の開始時刻」を未来にして、過去の購入記録を再現する
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await x(admin).from("box_settings").upsert({ household_id: hid, sync_enabled_from: future }, { onConflict: "household_id" })).error).toBeNull();
    const before = (await stock(u1, prodB)).unknown;
    const { itemId } = await newPurchase(prodB, 2, 9000);
    expect(await lotOf(itemId)).toBeNull();
    expect((await stock(u1, prodB)).unknown).toBe(before);
    // 編集しても自動では取り込まれない
    await u1.from("purchase_items").update({ amount_paid: 9500 }).eq("id", itemId);
    expect(await lotOf(itemId)).toBeNull();
    const list = await loadBoxCollection(u1);
    expect(list.ok && list.value.importable.some((i) => i.purchaseItemId === itemId)).toBe(true);
    const imp = await importPurchaseItem(u1, itemId, actor);
    expect(imp.ok, JSON.stringify(imp)).toBe(true);
    await importPurchaseItem(u1, itemId, actor);
    expect((await stock(u1, prodB)).unknown).toBe(before + 2);
    // 取り込み後は購入記録と連動する
    await u1.from("purchase_items").update({ quantity: 3 }).eq("id", itemId);
    expect((await stock(u1, prodB)).unknown).toBe(before + 3);
    const after = await loadBoxCollection(u1);
    expect(after.ok && after.value.importable.some((i) => i.purchaseItemId === itemId)).toBe(false);
  });

  it("相場: 追記方式で現在の値は最新の確認日。補正倍率は保存でき、範囲外は拒否", async () => {
    expect((await addBoxPrices(u1, hid, [{ productId: prodA, state: null, amountYen: 9000, confirmedOn: "2026-11-01", source: "手動" }], actor)).ok).toBe(true);
    expect((await addBoxPrices(u1, hid, [{ productId: prodA, state: null, amountYen: 10000, confirmedOn: "2026-12-01", source: "手動" }, { productId: prodA, state: "no_shrink", amountYen: 7000, confirmedOn: "2026-12-01", source: "手動" }], actor)).ok).toBe(true);
    const c = await loadBoxCollection(u1);
    expect(c.ok && c.value.prices.filter((p) => p.productId === prodA).length).toBe(3); // 過去の値も残る
    expect((await saveBoxSettings(u1, hid, { shrinkPct: 100, noShrinkPct: 80 }, actor)).ok).toBe(true);
    expect((await loadBoxCollection(u1)).ok && (await loadBoxCollection(u1))).toBeTruthy();
    const after = await loadBoxCollection(u1);
    expect(after.ok && after.value.settings).toEqual({ shrinkPct: 100, noShrinkPct: 80 });
    expect((await saveBoxSettings(u1, hid, { shrinkPct: 0, noShrinkPct: 80 }, actor)).ok).toBe(false);
    // 他の世帯の商品には相場を入れられない
    const foreign = await addBoxPrices(u2, hid2, [{ productId: prodA, state: null, amountYen: 1, confirmedOn: "2026-12-01", source: "x" }], actor);
    expect(foreign.ok).toBe(false);
  });

  it("履歴は追記のみ（更新・削除不可）。利用者が履歴・ロットを直接書き換えられない", async () => {
    const mv = (await x(u1).from("box_movements").select("id,lot_id").limit(1)).data[0];
    expect((await x(u1).from("box_movements").insert({ household_id: hid, lot_id: mv.lot_id, kind: "adjust", shrink_state: "shrink", qty: 5 })).error).not.toBeNull();
    expect((await x(u1).from("box_movements").update({ qty: 99 }).eq("id", mv.id)).error ?? { ok: 1 }).toBeTruthy();
    const still = (await x(u1).from("box_movements").select("qty").eq("id", mv.id).single()).data;
    expect(still.qty).not.toBe(99);
    expect((await x(admin).from("box_movements").update({ qty: 99 }).eq("id", mv.id)).error?.message).toContain("append-only");
    expect((await x(admin).from("box_movements").delete().eq("id", mv.id)).error?.message).toContain("append-only");
    expect((await x(u1).from("box_lots").insert({ household_id: hid, product_id: prodA, source_kind: "manual" })).error).not.toBeNull();
    expect((await x(u1).from("box_lots").update({ note: "改ざん" }).eq("id", mv.lot_id)).error ?? { ok: 1 }).toBeTruthy();
    const lot = (await x(u1).from("box_lots").select("note").eq("id", mv.lot_id).single()).data;
    expect(lot.note).not.toBe("改ざん");
  });

  it("世帯分離: 他の世帯のロット・履歴・相場は見えず、在庫の操作・取り込みもできない", async () => {
    expect(((await x(u2).from("box_lots").select("id")).data ?? []).length).toBe(0);
    expect(((await x(u2).from("box_movements").select("id")).data ?? []).length).toBe(0);
    expect(((await x(u2).from("box_prices").select("id")).data ?? []).length).toBe(0);
    const open = await openBoxes(u2, hid, { productId: prodA, state: "shrink", quantity: 1, opId: randomUUID() }, actor);
    expect(open.ok).toBe(false);
    const manual = await addManualBox(u2, hid, { productId: prodA, state: "shrink", quantity: 1, acquiredOn: null, storeLabel: "", actualUnitPrice: null, marketUnitPrice: null, marketPriceSource: "", marketPriceDate: null, note: "", opId: randomUUID() }, actor);
    expect(manual.ok).toBe(false);
    const item = (await x(u1).from("purchase_items").select("id").eq("household_id", hid).eq("unit", "box").limit(1)).data[0].id;
    expect((await importPurchaseItem(u2, item, actor)).ok).toBe(false);
    // 自世帯の他の商品でも他世帯の商品は選べない（複合FK）
    const own = await addManualBox(u2, hid2, { productId: prodA, state: "shrink", quantity: 1, acquiredOn: null, storeLabel: "", actualUnitPrice: null, marketUnitPrice: null, marketPriceSource: "", marketPriceDate: null, note: "", opId: randomUUID() }, actor);
    expect(own.ok).toBe(false);
  });
});
