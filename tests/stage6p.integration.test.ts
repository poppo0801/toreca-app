/**
 * Stage 6P の結合テスト（実Supabase・RLS適用下）。
 *   npm run test:db   ※ マイグレーション 20261126000071 / 20261126000072 の適用後に実行する
 * 登録済みBOXのシュリンク状態の変更、商品マスターの削除（参照保護）・統合（参照の付け替え・在庫の二重計上防止・冪等・世帯分離）。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addManualBox, loadProductStock, reclassifyBox } from "@/lib/server/box-collection-service";
import { deleteProduct, mergeProducts, previewMerge, productReferences } from "@/lib/server/product-merge-service";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 6P: BOXの状態変更・商品の削除/統合", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let actor: string;
  let storeId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
  const x = (db: unknown) => db as any;
  const today = new Date().toISOString().slice(0, 10);
  const mkProduct = async (name: string, over: Record<string, unknown> = {}) =>
    (await u1.from("products").insert({ household_id: hid, official_name: name, packs_per_box: 30, ...over } as never).select("id").single()).data!.id as string;
  const stock = async (pid: string) => {
    const r = await loadProductStock(u1, pid);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const manual = async (productId: string, state: "shrink" | "no_shrink" | "unknown", quantity: number) => {
    const r = await addManualBox(u1, hid, { productId, state, quantity, acquiredOn: "2026-10-01", storeLabel: "テスト店", actualUnitPrice: 5400, marketUnitPrice: null, marketPriceSource: "", marketPriceDate: null, note: "", opId: randomUUID() }, actor);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r as { value: { lotId: string } }).value.lotId;
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6p", 1);
    const b = await signInTestUser(admin, "s6p", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    actor = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    const chain = (await u1.from("chains").insert({ household_id: hid, name: "6P系列" }).select("id").single()).data!.id;
    storeId = (await u1.from("stores").insert({ household_id: hid, chain_id: chain, name: "6P店" }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  describe("登録済みBOXのシュリンク状態の変更", () => {
    it("状態を移すと所有数の合計は変わらず、評価に使う状態別の数量だけが変わる。同じ操作の再送は二重に動かさない", async () => {
      const p = await mkProduct("6P状態変更BOX");
      const lot = await manual(p, "unknown", 3);
      expect(await stock(p)).toEqual({ shrink: 0, no_shrink: 0, unknown: 3 });
      const op = randomUUID();
      const r1 = await reclassifyBox(u1, { lotId: lot, from: "unknown", to: "shrink", quantity: 2, opId: op, note: "実物を確認" }, actor);
      expect(r1.ok, JSON.stringify(r1)).toBe(true);
      expect((await reclassifyBox(u1, { lotId: lot, from: "unknown", to: "shrink", quantity: 2, opId: op }, actor)).ok).toBe(true); // 再送
      expect(await stock(p)).toEqual({ shrink: 2, no_shrink: 0, unknown: 1 });
      // 履歴は追記のみ（元の登録の行は残り、変更が2行追記される）
      const rows = (await x(u1).from("box_movements").select("kind,shrink_state,qty,op_id").eq("lot_id", lot)).data as { kind: string; shrink_state: string; qty: number; op_id: string | null }[];
      expect(rows.filter((m) => m.op_id === op).map((m) => `${m.shrink_state}:${m.qty}`).sort()).toEqual(["shrink:2", "unknown:-2"]);
      expect(rows.some((m) => m.kind === "adjust" || m.kind === "purchase" || m.kind === "receive")).toBe(true);
      expect(rows.reduce((a, m) => a + m.qty, 0)).toBe(3);
    });
    it("元の状態の残数を超える変更・同じ状態への変更は拒否される。取り消しで元に戻る", async () => {
      const p = await mkProduct("6P状態変更BOX2");
      const lot = await manual(p, "shrink", 2);
      expect((await reclassifyBox(u1, { lotId: lot, from: "shrink", to: "no_shrink", quantity: 3, opId: randomUUID() }, actor)).ok).toBe(false);
      expect((await reclassifyBox(u1, { lotId: lot, from: "shrink", to: "shrink", quantity: 1, opId: randomUUID() }, actor)).ok).toBe(false);
      const op = randomUUID();
      expect((await reclassifyBox(u1, { lotId: lot, from: "shrink", to: "unknown", quantity: 1, opId: op }, actor)).ok).toBe(true);
      expect(await stock(p)).toEqual({ shrink: 1, no_shrink: 0, unknown: 1 });
      const rv = await x(u1).rpc("box_revert_op", { p_household: hid, p_op: op, p_actor: actor });
      expect(rv.error).toBeNull();
      expect(await stock(p)).toEqual({ shrink: 2, no_shrink: 0, unknown: 0 });
    });
    it("購入記録と連動するロットの状態を変えても、購入記録の数量を直しても二重に数えない", async () => {
      const p = await mkProduct("6P連動BOX");
      const pur = (await u1.from("purchases").insert({ household_id: hid, store_id: storeId, source_kind: "manual", purchased_at: new Date().toISOString(), updated_by_profile_id: actor }).select("id").single()).data!.id;
      const item = (await u1.from("purchase_items").insert({ household_id: hid, purchase_id: pur, product_id: p, quantity: 4, unit: "box", amount_paid: 20000 }).select("id").single()).data!.id;
      const lot = (await x(u1).from("box_lots").select("id").eq("purchase_item_id", item).single()).data.id as string;
      expect(await stock(p)).toEqual({ shrink: 0, no_shrink: 0, unknown: 4 });
      expect((await reclassifyBox(u1, { lotId: lot, from: "unknown", to: "no_shrink", quantity: 4, opId: randomUUID() }, actor)).ok).toBe(true);
      expect(await stock(p)).toEqual({ shrink: 0, no_shrink: 4, unknown: 0 });
      // 購入記録の保存し直し（同じ内容）で状態が戻らず、増えもしない
      await u1.from("purchase_items").update({ amount_paid: 20000 }).eq("id", item);
      expect(await stock(p)).toEqual({ shrink: 0, no_shrink: 4, unknown: 0 });
    });
    it("他世帯のロットは変更できない", async () => {
      const p = await mkProduct("6P世帯分離BOX");
      const lot = await manual(p, "unknown", 1);
      expect((await reclassifyBox(u2, { lotId: lot, from: "unknown", to: "shrink", quantity: 1, opId: randomUUID() }, null)).ok).toBe(false);
      expect(await stock(p)).toEqual({ shrink: 0, no_shrink: 0, unknown: 1 });
    });
  });

  describe("商品マスターの削除", () => {
    it("参照が無い商品は削除できる（付属の別名・価格も消える）", async () => {
      const p = await mkProduct("6P削除OK");
      await u1.from("product_aliases").insert({ household_id: hid, product_id: p, alias: "6P別名", normalized_alias: "6p別名" });
      const refs = await productReferences(u1, p);
      expect(refs.ok && refs.value.aliases).toBe(1);
      expect((await deleteProduct(u1, p)).ok).toBe(true);
      expect((await u1.from("products").select("id").eq("id", p)).data).toHaveLength(0);
    });
    it("購入・BOX・抽選などから参照されている商品は削除できず、履歴は残る", async () => {
      const p = await mkProduct("6P削除NG");
      await manual(p, "shrink", 1);
      const r = await deleteProduct(u1, p);
      expect(r.ok).toBe(false);
      expect((await u1.from("products").select("id").eq("id", p)).data).toHaveLength(1);
      expect((await x(u1).from("box_lots").select("id").eq("product_id", p)).data).toHaveLength(1);
      const refs = await productReferences(u1, p);
      expect(refs.ok && refs.value.box_lots).toBe(1);
    });
    it("他世帯の商品は調査も削除もできない", async () => {
      const p = await mkProduct("6P他世帯削除");
      expect((await productReferences(u2, p)).ok).toBe(false);
      expect((await deleteProduct(u2, p)).ok).toBe(false);
    });
  });

  describe("商品の統合", () => {
    it("参照を統合先へ付け替え、購入数量・売却数量・BOX在庫は二重計上されない。統合元は非表示で残り、履歴が記録される。再実行しても変わらない", async () => {
      const from = await mkProduct("6P統合元（別表記）");
      const into = await mkProduct("6P統合先", { product_code: "s6p1" }); // 統合元はコード未登録（コードが片方だけなら統合できる）
      // 統合元・統合先それぞれに BOX（手動）と購入明細・売却・抽選
      await manual(from, "shrink", 2);
      await manual(into, "unknown", 3);
      const pur = (await u1.from("purchases").insert({ household_id: hid, store_id: storeId, source_kind: "manual", purchased_at: new Date().toISOString(), updated_by_profile_id: actor }).select("id").single()).data!.id;
      await u1.from("purchase_items").insert({ household_id: hid, purchase_id: pur, product_id: from, quantity: 5, unit: "pack", amount_paid: 3000 });
      await u1.from("sales").insert({ household_id: hid, sold_on: today, platform: "テスト", product_id: from, quantity: 1, unit: "box", amount: 1000, seller_profile_id: actor, box_state: "shrink" } as never);
      await u1.from("product_aliases").insert({ household_id: hid, product_id: from, alias: "6P旧名", normalized_alias: "6p旧名" });
      const beforeFrom = await stock(from);
      const beforeInto = await stock(into);
      expect(beforeFrom.shrink).toBe(1); // 2 - 売却1

      const pv = await previewMerge(u1, from, into, actor);
      expect(pv.ok).toBe(true);
      if (pv.ok) {
        expect(pv.value.from.purchase_items).toBe(1);
        expect(pv.value.from.sales).toBe(1);
        expect(pv.value.from.box_lots).toBe(1);
      }
      // プレビューは何も変更しない
      expect((await u1.from("products").select("archived_at").eq("id", from).single()).data!.archived_at).toBeNull();

      const m = await mergeProducts(u1, from, into, actor);
      expect(m.ok, JSON.stringify(m)).toBe(true);
      // 参照は統合先へ
      expect((await u1.from("purchase_items").select("id").eq("product_id", into)).data).toHaveLength(1);
      expect((await u1.from("purchase_items").select("id").eq("product_id", from)).data).toHaveLength(0);
      expect((await u1.from("sales").select("id").eq("product_id", into)).data).toHaveLength(1);
      expect((await x(u1).from("box_lots").select("id").eq("product_id", into)).data).toHaveLength(2);
      // 在庫は合計のまま（二重計上なし）
      const afterInto = await stock(into);
      expect(afterInto.shrink).toBe(beforeInto.shrink + beforeFrom.shrink);
      expect(afterInto.unknown).toBe(beforeInto.unknown + beforeFrom.unknown);
      expect(afterInto.no_shrink).toBe(0);
      expect(await stock(from)).toEqual({ shrink: 0, no_shrink: 0, unknown: 0 });
      // 統合元は削除せず非表示。別名が統合先へ引き継がれ、統合元の名前も別名になる
      const old = (await u1.from("products").select("archived_at").eq("id", from).single()).data!;
      expect(old.archived_at).not.toBeNull();
      const aliases = (await u1.from("product_aliases").select("alias").eq("product_id", into)).data!.map((a) => a.alias);
      expect(aliases).toEqual(expect.arrayContaining(["6P旧名", "6P統合元（別表記）"]));
      // 対応履歴
      const h = (await x(u1).from("product_merge_history").select("from_name,into_name,counts").eq("from_product_id", from)).data;
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({ from_name: "6P統合元（別表記）", into_name: "6P統合先" });
      // 再実行しても重複・破損しない
      const again = await mergeProducts(u1, from, into, actor);
      expect(again.ok && again.value.already).toBe(true);
      expect((await stock(into))).toEqual(afterInto);
      expect((await x(u1).from("product_merge_history").select("id").eq("from_product_id", from)).data).toHaveLength(1);
    });
    it("統合先の画像・価格などは上書きしない（統合先に無いものだけ引き継ぐ）", async () => {
      const from = await mkProduct("6P価格元", { list_price_box: 5400, release_date: "2024-01-01" });
      const into = await mkProduct("6P価格先", { list_price_box: 6000, release_date: "2025-05-05" });
      await x(u1).from("box_prices").insert([
        { household_id: hid, product_id: from, shrink_state: null, amount_yen: 7000, confirmed_on: today, source: "元", updated_by_profile_id: actor },
        { household_id: hid, product_id: from, shrink_state: "shrink", amount_yen: 8000, confirmed_on: today, source: "元", updated_by_profile_id: actor },
        { household_id: hid, product_id: into, shrink_state: null, amount_yen: 7500, confirmed_on: today, source: "先", updated_by_profile_id: actor },
      ]);
      expect((await mergeProducts(u1, from, into, actor)).ok).toBe(true);
      const t = (await u1.from("products").select("list_price_box,release_date").eq("id", into).single()).data!;
      expect(t).toMatchObject({ list_price_box: 6000, release_date: "2025-05-05" });
      const prices = (await x(u1).from("box_prices").select("shrink_state,amount_yen").eq("product_id", into)).data as { shrink_state: string | null; amount_yen: number }[];
      expect(prices.find((p) => p.shrink_state === null)!.amount_yen).toBe(7500); // 統合先の基準相場は上書きしない
      expect(prices.some((p) => p.shrink_state === "shrink" && p.amount_yen === 8000)).toBe(true); // 統合先に無い状態の相場は引き継ぐ
    });
    it("商品コード・商品区分・パック数が食い違う商品は統合できない（誤統合の防止）。何も変更されない", async () => {
      const a = await mkProduct("6P別コードA", { product_code: "AAA1" });
      const b = await mkProduct("6P別コードB", { product_code: "BBB2" });
      const r = await mergeProducts(u1, a, b, actor);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("商品コード");
      expect((await u1.from("products").select("archived_at").eq("id", a).single()).data!.archived_at).toBeNull();
      const k1 = await mkProduct("6P区分A", { product_kind: "deck" });
      const k2 = await mkProduct("6P区分B", { product_kind: "expansion_pack" });
      expect((await mergeProducts(u1, k1, k2, actor)).ok).toBe(false);
      const p1 = await mkProduct("6Pパック数A", { packs_per_box: 20 });
      const p2 = await mkProduct("6Pパック数B", { packs_per_box: 30 });
      expect((await mergeProducts(u1, p1, p2, actor)).ok).toBe(false);
      expect((await mergeProducts(u1, a, a, actor)).ok).toBe(false);
    });
    it("他世帯の商品とは統合できず、他世帯からは操作できない", async () => {
      const mine = await mkProduct("6P世帯A商品");
      const mine2 = await mkProduct("6P世帯A商品2");
      const other = (await u2.from("products").insert({ household_id: (await u2.rpc("bootstrap_household")).data as string, official_name: "6P世帯B商品", packs_per_box: 30 }).select("id").single()).data!.id;
      expect((await mergeProducts(u1, mine, other, actor)).ok).toBe(false);
      expect((await mergeProducts(u2, mine, mine2, null)).ok).toBe(false);
      expect((await previewMerge(u2, mine, mine2, null)).ok).toBe(false);
    });
  });
});
