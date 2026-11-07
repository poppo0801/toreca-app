import { expenseSchema, saleSchema, type ExpenseInput, type SaleInput } from "@/lib/finance-input";
import { categoryOf } from "@/lib/expense-category";
import { normName } from "@/lib/norm";
import { mapDbError, type Db, type ServiceResult } from "@/lib/server/lottery-service";
import { z } from "zod";

/**
 * 収支（支出=購入記録 / 収入=売却記録）のDB操作。購入実績と収支明細は同じ purchases / purchase_items を使うため二重計上しない。
 * 認証済み(RLS適用)のクライアントを受け取る。service_role は使わない。
 */
const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
const fail = (error: string): ServiceResult<never> => ({ ok: false, error });
const uuid = z.uuid();
const nowIso = () => new Date().toISOString();

/** 自由入力された商品名が既存マスター（名称・略称）と一致すれば、そのIDを返す（推測で新規作成はしない）。 */
async function matchProduct(db: Db, ref: { id: string | null; name: string }): Promise<string | null> {
  if (ref.id) return ref.id;
  const key = normName(ref.name);
  if (!key) return null;
  const [{ data: products }, { data: aliases }] = await Promise.all([
    db.from("products").select("id,official_name").is("archived_at", null),
    db.from("product_aliases").select("product_id,normalized_alias"),
  ]);
  const byName = (products ?? []).find((p) => normName(p.official_name) === key);
  if (byName) return byName.id;
  const byAlias = (aliases ?? []).find((a) => normName(a.normalized_alias) === key);
  return byAlias?.product_id ?? null;
}

async function matchStore(db: Db, ref: { id: string | null; name: string }, chainId: string | null = null): Promise<string | null> {
  if (ref.id) return ref.id;
  const key = normName(ref.name);
  if (!key) return null;
  let q = db.from("stores").select("id,name,chain_id").is("archived_at", null);
  if (chainId) q = q.eq("chain_id", chainId); // 選んだ系列の店舗に限る
  const { data } = await q;
  const hits = (data ?? []).filter((s) => normName(s.name) === key);
  return hits.length === 1 ? hits[0].id : null; // 複数の系列に同名店舗がある場合は推測しない
}

/**
 * 系列の決定（Stage 6N）。選択した系列を優先し、未選択のときは店舗マスターの系列を使う。
 * 未登録の系列名は仮登録として追加する（既存の系列名・別名と一致するときは新規に作らない）。
 */
async function resolveChain(db: Db, householdId: string, chain: { id: string | null; name: string } | undefined, storeId: string | null): Promise<string | null> {
  if (chain?.id) return chain.id;
  const key = normName(chain?.name ?? "");
  if (key) {
    const [{ data: chains }, { data: aliases }] = await Promise.all([db.from("chains").select("id,name").is("archived_at", null), db.from("chain_aliases").select("chain_id,normalized_alias")]);
    const byName = (chains ?? []).filter((c) => normName(c.name) === key);
    const byAlias = (aliases ?? []).filter((a) => normName(a.normalized_alias) === key).map((a) => a.chain_id);
    const hits = [...new Set([...byName.map((c) => c.id), ...byAlias])];
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      const { data, error } = await db.from("chains").insert({ household_id: householdId, name: chain!.name.trim(), is_provisional: true }).select("id").single();
      if (!error && data) return data.id;
    }
    return null; // 同名が複数あるときは決めない
  }
  if (storeId) {
    const { data } = await db.from("stores").select("chain_id").eq("id", storeId).maybeSingle();
    return data?.chain_id ?? null;
  }
  return null;
}

export async function saveExpense(
  db: Db,
  householdId: string,
  id: string | null,
  raw: ExpenseInput,
  actor: string | null,
): Promise<ServiceResult<{ id: string }>> {
  const parsed = expenseSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  const v = parsed.data;
  if (id !== null && !uuid.safeParse(id).success) return fail("リクエストが不正です");

  const cat = categoryOf(v.category);
  // 系列＋店舗（Stage 6N）。店舗は選んだ系列の店舗に限り、店舗名が空なら系列のみで保存する
  const chainId = await resolveChain(db, householdId, v.chain, null);
  const storeId = await matchStore(db, v.store, chainId);
  const resolvedChain = chainId ?? (storeId ? await resolveChain(db, householdId, undefined, storeId) : null);
  const header = {
    category: cat.id,
    chain_id: resolvedChain,
    store_id: storeId,
    store_label: storeId ? null : v.store.name || null,
    purchased_date: v.date,
    purchased_at: null,
    channel: v.channel,
    note: v.note,
    updated_by_profile_id: actor,
  };

  let purchaseId = id;
  if (id === null) {
    const { data, error } = await db
      .from("purchases")
      .insert({ ...header, household_id: householdId, buyer_profile_id: actor, source_kind: "manual" })
      .select("id")
      .single();
    if (error) return fail(mapDbError(error));
    purchaseId = data.id;
  } else {
    const { data, error } = await db.from("purchases").update(header).eq("id", id).is("archived_at", null).select("id").maybeSingle();
    if (error) return fail(mapDbError(error));
    if (!data) return fail("対象のデータが見つかりません");
  }

  const keep: string[] = [];
  for (const item of v.items) {
    // 商品マスターと連携するのはポケモンカードだけ。周辺グッズ・経費は自由入力のまま（マスターには紐づけない）
    const productId = cat.master ? await matchProduct(db, item.product) : null;
    const row = {
      product_id: productId,
      product_label: productId ? null : item.product.name,
      quantity: cat.quantity ? item.quantity : 1,
      unit: cat.quantity ? item.unit : "piece",
      amount_paid: item.amountPaid,
      updated_by_profile_id: actor,
    };
    if (item.id) {
      const { error } = await db.from("purchase_items").update(row).eq("id", item.id).eq("purchase_id", purchaseId as string);
      if (error) return fail(mapDbError(error));
      keep.push(item.id);
    } else {
      const { data, error } = await db
        .from("purchase_items")
        .insert({ ...row, household_id: householdId, purchase_id: purchaseId as string })
        .select("id")
        .single();
      if (error) return fail(mapDbError(error));
      keep.push(data.id);
    }
  }
  if (id !== null) {
    // 編集で外された明細だけを削除（売却の原価に紐づく明細は FK により削除できず、エラーで知らせる）
    const { data: all } = await db.from("purchase_items").select("id").eq("purchase_id", id);
    const removed = (all ?? []).map((r) => r.id).filter((x) => !keep.includes(x));
    if (removed.length > 0) {
      const { error } = await db.from("purchase_items").delete().in("id", removed);
      if (error) return fail(error.code === "23503" ? "売却の購入原価に使われている明細は削除できません" : mapDbError(error));
    }
  }
  return ok({ id: purchaseId as string });
}

/** 削除は論理削除。抽選当選から自動作成された購入は削除できない（購入済みの応募と食い違うため）。 */
export async function deleteExpense(db: Db, id: string, actor: string | null): Promise<ServiceResult> {
  if (!uuid.safeParse(id).success) return fail("リクエストが不正です");
  const { data: p } = await db.from("purchases").select("source_kind").eq("id", id).maybeSingle();
  if (!p) return fail("対象のデータが見つかりません");
  if (p.source_kind === "lottery") return fail("抽選の当選から作成された購入は削除できません（内容の修正は可能です）");
  const { data: items } = await db.from("purchase_items").select("id").eq("purchase_id", id);
  const { data: used } = await db.from("sales").select("id").in("cost_purchase_item_id", (items ?? []).map((i) => i.id)).is("archived_at", null).limit(1);
  if ((used ?? []).length > 0) return fail("売却の購入原価に使われているため削除できません");
  const { error } = await db.from("purchases").update({ archived_at: nowIso(), updated_by_profile_id: actor }).eq("id", id);
  return error ? fail(mapDbError(error)) : ok(undefined);
}

export async function saveSale(
  db: Db,
  householdId: string,
  id: string | null,
  raw: SaleInput,
  actor: string | null,
): Promise<ServiceResult<{ id: string }>> {
  const parsed = saleSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
  const v = parsed.data;
  if (id !== null && !uuid.safeParse(id).success) return fail("リクエストが不正です");
  if ((v.costPurchaseItemId === null) !== (v.costQuantity === null)) return fail("購入原価の紐づけには購入明細と数量の両方が必要です");

  const productId = await matchProduct(db, v.product);
  const row = {
    sold_on: v.soldOn,
    platform: v.platform,
    product_id: productId,
    product_label: productId ? null : v.product.name,
    quantity: v.quantity,
    unit: v.unit,
    amount: v.amount,
    seller_profile_id: v.sellerProfileId,
    // BOXの売却だけ、減らす在庫の状態を持つ（所有数の増減はDBの連動が行う。超過は拒否される）
    box_state: productId && v.unit === "box" ? (v.boxState ?? null) : null,
    cost_amount: v.costAmount,
    cost_purchase_item_id: v.costPurchaseItemId,
    cost_quantity: v.costQuantity,
    fee: v.fee,
    shipping: v.shipping,
    memo: v.memo,
    updated_by_profile_id: actor,
  };
  if (id === null) {
    const { data, error } = await db.from("sales").insert({ ...row, household_id: householdId }).select("id").single();
    if (error) return fail(mapDbError(error));
    return ok({ id: data.id });
  }
  const { data, error } = await db.from("sales").update(row).eq("id", id).is("archived_at", null).select("id").maybeSingle();
  if (error) return fail(mapDbError(error));
  return data ? ok({ id: data.id }) : fail("対象のデータが見つかりません");
}

export async function deleteSale(db: Db, id: string, actor: string | null): Promise<ServiceResult> {
  if (!uuid.safeParse(id).success) return fail("リクエストが不正です");
  const { data, error } = await db.from("sales").update({ archived_at: nowIso(), updated_by_profile_id: actor }).eq("id", id).select("id").maybeSingle();
  if (error) return fail(mapDbError(error));
  return data ? ok(undefined) : fail("対象のデータが見つかりません");
}
