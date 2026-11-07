import { z } from "zod";
import type { BoxLotRow, BoxMovementRow, BoxPriceRow, BoxProductInfo, BoxSettings } from "@/lib/box-collection";
import { DEFAULT_BOX_SETTINGS } from "@/lib/box-collection";
import { mapDbError, type Db, type ServiceResult } from "@/lib/server/lottery-service";

/**
 * BOXコレクションの読み書き（Stage 6M）。認証済み(RLS適用)のクライアントを受け取る。
 * 在庫の変更はすべてDBの関数（検証・ロック・履歴の追記）経由で、ここから履歴やロットを直接書かない。
 * 操作ID(opId)は画面を開いた時点で作り、再送・多重タップで二重に動かさない。
 */
const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
const fail = (error: string): ServiceResult<never> => ({ ok: false, error });
const uuid = z.uuid();
const state = z.enum(["shrink", "no_shrink", "unknown"]);
const yen = z.number().int().min(0).max(100_000_000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付の形式が正しくありません");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
const any = (db: Db) => db as any;

export interface ImportableItem {
  purchaseItemId: string;
  productId: string;
  productName: string;
  quantity: number;
  amountPaid: number | null;
  purchasedOn: string | null;
  storeLabel: string;
}

export interface BoxCollectionData {
  products: BoxProductInfo[];
  lots: BoxLotRow[];
  movements: BoxMovementRow[];
  prices: BoxPriceRow[];
  settings: BoxSettings;
  /** 購入記録にあるBOXで、まだBOXコレクションに入っていないもの（過去の購入記録の手動取り込み用） */
  importable: ImportableItem[];
}

type Row = Record<string, unknown>;

export async function loadBoxCollection(db: Db): Promise<ServiceResult<BoxCollectionData>> {
  const [pr, lo, mv, bp, st] = await Promise.all([
    any(db).from("products").select("id,official_name,release_date").limit(5000),
    any(db).from("box_lots").select("*").limit(5000),
    any(db).from("box_movements").select("*").order("occurred_at", { ascending: false }).limit(20000),
    any(db).from("box_prices").select("*").order("confirmed_on", { ascending: false }).limit(20000),
    any(db).from("box_settings").select("shrink_pct,no_shrink_pct").maybeSingle(),
  ]);
  if (pr.error || lo.error || mv.error || bp.error) return fail("BOXコレクションを取得できませんでした");
  const lots: BoxLotRow[] = (lo.data as Row[]).map((r) => ({
    id: r.id as string,
    productId: r.product_id as string,
    sourceKind: r.source_kind as "purchase" | "manual",
    purchaseItemId: (r.purchase_item_id as string | null) ?? null,
    acquiredOn: (r.acquired_on as string | null) ?? null,
    chainId: (r.chain_id as string | null) ?? null,
    storeId: (r.store_id as string | null) ?? null,
    storeLabel: (r.store_label as string) ?? "",
    actualUnitPrice: (r.actual_unit_price as number | null) ?? null,
    marketUnitPrice: (r.market_unit_price as number | null) ?? null,
    marketPriceSource: (r.market_price_source as string) ?? "",
    marketPriceDate: (r.market_price_date as string | null) ?? null,
    note: (r.note as string) ?? "",
    archived: r.archived_at != null,
    createdAt: r.created_at as string,
  }));
  const movements: BoxMovementRow[] = (mv.data as Row[]).map((r) => ({
    id: r.id as string,
    lotId: r.lot_id as string,
    kind: r.kind as BoxMovementRow["kind"],
    state: r.shrink_state as BoxMovementRow["state"],
    qty: r.qty as number,
    opId: (r.op_id as string | null) ?? null,
    revertsOp: (r.reverts_op as string | null) ?? null,
    refId: (r.ref_id as string | null) ?? null,
    note: (r.note as string) ?? "",
    occurredAt: r.occurred_at as string,
  }));
  const prices: BoxPriceRow[] = (bp.data as Row[]).map((r) => ({
    id: r.id as string,
    productId: r.product_id as string,
    state: (r.shrink_state as BoxPriceRow["state"]) ?? null,
    amountYen: r.amount_yen as number,
    confirmedOn: r.confirmed_on as string,
    source: (r.source as string) ?? "",
    createdAt: r.created_at as string,
  }));
  const products: BoxProductInfo[] = (pr.data as Row[]).map((r) => ({ id: r.id as string, name: r.official_name as string, releaseDate: (r.release_date as string | null) ?? null }));
  const settings: BoxSettings = st.data ? { shrinkPct: st.data.shrink_pct, noShrinkPct: st.data.no_shrink_pct } : DEFAULT_BOX_SETTINGS;

  // 取り込み候補: BOXの購入明細のうち、ロットに紐づいていないもの（削除済みの購入は除く）
  const linked = new Set(lots.map((l) => l.purchaseItemId).filter(Boolean) as string[]);
  const pi = await any(db).from("purchase_items").select("id,purchase_id,product_id,quantity,amount_paid").eq("unit", "box").not("product_id", "is", null).limit(1000);
  let importable: ImportableItem[] = [];
  if (!pi.error && pi.data.length > 0) {
    const purchaseIds = [...new Set((pi.data as Row[]).map((r) => r.purchase_id as string))];
    const pu = await any(db).from("purchases").select("id,purchased_at,store_label,store_id,archived_at").in("id", purchaseIds).is("archived_at", null);
    const stores = await any(db).from("stores").select("id,name").limit(5000);
    const sname = new Map(((stores.data ?? []) as Row[]).map((s) => [s.id as string, s.name as string]));
    const pmap = new Map(((pu.data ?? []) as Row[]).map((p) => [p.id as string, p]));
    const names = new Map(products.map((p) => [p.id, p.name]));
    importable = (pi.data as Row[])
      .filter((r) => !linked.has(r.id as string) && pmap.has(r.purchase_id as string))
      .map((r) => {
        const p = pmap.get(r.purchase_id as string)!;
        const at = p.purchased_at as string | null;
        return {
          purchaseItemId: r.id as string,
          productId: r.product_id as string,
          productName: names.get(r.product_id as string) ?? "商品未登録",
          quantity: r.quantity as number,
          amountPaid: (r.amount_paid as number | null) ?? null,
          purchasedOn: at ? new Date(new Date(at).getTime() + 9 * 3600_000).toISOString().slice(0, 10) : null,
          storeLabel: (p.store_id ? sname.get(p.store_id as string) : null) ?? ((p.store_label as string) || ""),
        };
      })
      .sort((a, b) => (b.purchasedOn ?? "").localeCompare(a.purchasedOn ?? ""));
  }
  return ok({ products, lots, movements, prices, settings, importable });
}

const manualSchema = z.object({
  productId: uuid,
  state,
  quantity: z.number().int().min(1, "数量は1以上").max(9999),
  acquiredOn: date.nullable(),
  storeLabel: z.string().trim().max(80).default(""),
  actualUnitPrice: yen.nullable(),
  marketUnitPrice: yen.nullable(),
  marketPriceSource: z.string().trim().max(60).default(""),
  marketPriceDate: date.nullable(),
  note: z.string().trim().max(500).default(""),
  opId: uuid,
});
export type ManualBoxInput = z.input<typeof manualSchema>;

export async function addManualBox(db: Db, householdId: string, raw: ManualBoxInput, actor: string | null): Promise<ServiceResult<{ lotId: string }>> {
  const p = manualSchema.safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const v = p.data;
  // 購入時点の市場相場は、取得元・基準日とセットで記録する（出所の分からない価格を履歴にしない）
  if (v.marketUnitPrice !== null && (v.marketPriceSource === "" || v.marketPriceDate === null)) return fail("購入時点の市場相場には、取得元と基準日が必要です");
  const { data, error } = await any(db).rpc("box_add_manual", {
    p_household: householdId,
    p_product: v.productId,
    p_state: v.state,
    p_qty: v.quantity,
    p_acquired_on: v.acquiredOn,
    p_chain: null,
    p_store: null,
    p_store_label: v.storeLabel,
    p_actual: v.actualUnitPrice,
    p_market: v.marketUnitPrice,
    p_market_source: v.marketPriceSource,
    p_market_date: v.marketPriceDate,
    p_note: v.note,
    p_actor: actor,
    p_op: v.opId,
  });
  return error ? fail(mapDbError(error)) : ok({ lotId: data as string });
}

const adjustSchema = z.object({ lotId: uuid, state, delta: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 9999, "増減は0以外の整数にしてください"), opId: uuid, note: z.string().trim().max(200).default("") });
export async function adjustBox(db: Db, raw: z.input<typeof adjustSchema>, actor: string | null): Promise<ServiceResult> {
  const p = adjustSchema.safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const { error } = await any(db).rpc("box_adjust", { p_lot: p.data.lotId, p_state: p.data.state, p_delta: p.data.delta, p_actor: actor, p_op: p.data.opId, p_note: p.data.note });
  return error ? fail(mapDbError(error)) : ok(undefined);
}

const reclassifySchema = z.object({ lotId: uuid, from: state, to: state, quantity: z.number().int().min(1).max(9999), opId: uuid, note: z.string().trim().max(150).default("") });
/**
 * 登録済みBOXのシュリンク状態の変更（Stage 6P）。ロットの元の状態から数量を引いて新しい状態へ足す（履歴に2行を追記）。
 * 所有数の合計・購入/受取/売却の履歴は変わらない。同じ操作IDの再送は何もしない。
 */
export async function reclassifyBox(db: Db, raw: z.input<typeof reclassifySchema>, actor: string | null): Promise<ServiceResult> {
  const p = reclassifySchema.safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  if (p.data.from === p.data.to) return fail("変更前と変更後の状態が同じです");
  const { error } = await any(db).rpc("box_reclassify", { p_lot: p.data.lotId, p_from: p.data.from, p_to: p.data.to, p_qty: p.data.quantity, p_actor: actor, p_op: p.data.opId, p_note: p.data.note });
  return error ? fail(mapDbError(error)) : ok(undefined);
}

const lotSchema = z.object({
  lotId: uuid,
  acquiredOn: date.nullable(),
  storeLabel: z.string().trim().max(80).default(""),
  actualUnitPrice: yen.nullable(),
  marketUnitPrice: yen.nullable(),
  marketPriceSource: z.string().trim().max(60).default(""),
  marketPriceDate: date.nullable(),
  note: z.string().trim().max(500).default(""),
});
export async function updateBoxLot(db: Db, raw: z.input<typeof lotSchema>, actor: string | null): Promise<ServiceResult> {
  const p = lotSchema.safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const v = p.data;
  if (v.marketUnitPrice !== null && (v.marketPriceSource === "" || v.marketPriceDate === null)) return fail("購入時点の市場相場には、取得元と基準日が必要です");
  const { error } = await any(db).rpc("box_update_lot", {
    p_lot: v.lotId,
    p_acquired_on: v.acquiredOn,
    p_store_label: v.storeLabel,
    p_actual: v.actualUnitPrice,
    p_market: v.marketUnitPrice,
    p_market_source: v.marketPriceSource,
    p_market_date: v.marketPriceDate,
    p_note: v.note,
    p_actor: actor,
  });
  return error ? fail(mapDbError(error)) : ok(undefined);
}

const openSchema = z.object({ productId: uuid, state, quantity: z.number().int().min(1, "数量は1以上").max(9999), opId: uuid, note: z.string().trim().max(200).default("") });
export async function openBoxes(db: Db, householdId: string, raw: z.input<typeof openSchema>, actor: string | null): Promise<ServiceResult> {
  const p = openSchema.safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const { error } = await any(db).rpc("box_open", { p_household: householdId, p_product: p.data.productId, p_state: p.data.state, p_qty: p.data.quantity, p_actor: actor, p_op: p.data.opId, p_note: p.data.note });
  return error ? fail(mapDbError(error)) : ok(undefined);
}

export async function revertBoxOp(db: Db, householdId: string, opId: string, actor: string | null): Promise<ServiceResult> {
  if (!uuid.safeParse(opId).success) return fail("リクエストが不正です");
  const { error } = await any(db).rpc("box_revert_op", { p_household: householdId, p_op: opId, p_actor: actor });
  return error ? fail(mapDbError(error)) : ok(undefined);
}

export async function importPurchaseItem(db: Db, purchaseItemId: string, actor: string | null): Promise<ServiceResult<{ lotId: string }>> {
  if (!uuid.safeParse(purchaseItemId).success) return fail("リクエストが不正です");
  const { data, error } = await any(db).rpc("box_import_purchase_item", { p_item: purchaseItemId, p_actor: actor });
  return error ? fail(mapDbError(error)) : ok({ lotId: data as string });
}

const priceSchema = z.object({
  productId: uuid,
  state: state.nullable(),
  amountYen: yen,
  confirmedOn: date,
  source: z.string().trim().max(60).default("手動"),
});
/** 参考買取相場を追記する（過去の値は残る。現在の値は確認日が最新の行） */
export async function addBoxPrices(db: Db, householdId: string, raws: z.input<typeof priceSchema>[], actor: string | null): Promise<ServiceResult> {
  const list = z.array(priceSchema).min(1).max(200).safeParse(raws);
  if (!list.success) return fail(list.error.issues[0]?.message ?? "入力内容を確認してください");
  const rows = list.data.map((v) => ({ household_id: householdId, product_id: v.productId, shrink_state: v.state, amount_yen: v.amountYen, confirmed_on: v.confirmedOn, source: v.source || "手動", updated_by_profile_id: actor }));
  const { error } = await any(db).from("box_prices").insert(rows);
  return error ? fail(mapDbError(error)) : ok(undefined);
}

const settingsSchema = z.object({ shrinkPct: z.number().int().min(1).max(200), noShrinkPct: z.number().int().min(1).max(200) });
export async function saveBoxSettings(db: Db, householdId: string, raw: z.input<typeof settingsSchema>, actor: string | null): Promise<ServiceResult> {
  const p = settingsSchema.safeParse(raw);
  if (!p.success) return fail("補正倍率は1〜200%の整数で入力してください");
  const { error } = await any(db).from("box_settings").upsert({ household_id: householdId, shrink_pct: p.data.shrinkPct, no_shrink_pct: p.data.noShrinkPct, updated_by_profile_id: actor }, { onConflict: "household_id" });
  return error ? fail(mapDbError(error)) : ok(undefined);
}

/** 商品の現在の所有数（状態別）。売却ダイアログで、在庫から減らす状態の候補を出すために使う */
export async function loadProductStock(db: Db, productId: string): Promise<ServiceResult<{ shrink: number; no_shrink: number; unknown: number }>> {
  if (!uuid.safeParse(productId).success) return fail("リクエストが不正です");
  const lots = await any(db).from("box_lots").select("id").eq("product_id", productId).is("archived_at", null).limit(2000);
  if (lots.error) return fail("在庫を取得できませんでした");
  const ids = (lots.data as { id: string }[]).map((l) => l.id);
  const out = { shrink: 0, no_shrink: 0, unknown: 0 };
  if (ids.length === 0) return ok(out);
  const mv = await any(db).from("box_movements").select("shrink_state,qty").in("lot_id", ids).limit(50000);
  if (mv.error) return fail("在庫を取得できませんでした");
  for (const r of mv.data as { shrink_state: keyof typeof out; qty: number }[]) out[r.shrink_state] += r.qty;
  return ok(out);
}
