import { z } from "zod";
import { receiptError, SHRINK_STATES, type ReceiptState } from "@/lib/product-kind";
import { mapDbError, type Db, type ServiceResult } from "@/lib/server/lottery-service";

/**
 * BOXの受取（シュリンク状態の記録）。認証済み(RLS適用)のクライアントを受け取る。
 * 記録は購入明細（BOX）ごとに、状態別の数量をまとめて置き換える（同じ内容を何度保存しても結果は変わらない）。
 */
const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
const fail = (error: string): ServiceResult<never> => ({ ok: false, error });
const uuid = z.uuid();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
const any = (db: Db) => db as any;

export interface BoxReceiptRow {
  purchaseItemId: string;
  receivedOn: string;
  state: ReceiptState["state"];
  quantity: number;
}

const stateSchema = z.object({ state: z.enum(SHRINK_STATES as [string, ...string[]]), quantity: z.number().int().min(1).max(9999) });

export async function loadBoxReceipts(db: Db, purchaseItemIds: string[]): Promise<ServiceResult<BoxReceiptRow[]>> {
  const ids = purchaseItemIds.filter((x) => uuid.safeParse(x).success).slice(0, 200);
  if (ids.length === 0) return ok([]);
  const { data, error } = await any(db).from("box_receipts").select("purchase_item_id,received_on,shrink_state,quantity").in("purchase_item_id", ids);
  if (error) return fail(mapDbError(error));
  return ok(
    (data as { purchase_item_id: string; received_on: string; shrink_state: ReceiptState["state"]; quantity: number }[]).map((r) => ({
      purchaseItemId: r.purchase_item_id,
      receivedOn: r.received_on,
      state: r.shrink_state,
      quantity: r.quantity,
    })),
  );
}

export async function recordBoxReceipt(
  db: Db,
  purchaseItemId: string,
  receivedOn: string,
  states: { state: string; quantity: number }[],
  actor: string | null,
): Promise<ServiceResult> {
  if (!uuid.safeParse(purchaseItemId).success) return fail("リクエストが不正です");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) return fail("受取日の形式が正しくありません");
  const parsed = z.array(stateSchema).max(3).safeParse(states.filter((s) => s.quantity > 0));
  if (!parsed.success) return fail("数量は1以上の整数で入力してください");
  const { data: item } = await db.from("purchase_items").select("quantity,unit").eq("id", purchaseItemId).maybeSingle();
  if (!item) return fail("対象のデータが見つかりません");
  if (item.unit !== "box") return fail("BOXの購入だけ、シュリンク状態を記録できます");
  const err = receiptError(parsed.data as ReceiptState[], item.quantity);
  if (err) return fail(err);
  const { error } = await any(db).rpc("record_box_receipt", { p_purchase_item_id: purchaseItemId, p_actor: actor, p_received_on: receivedOn, p_states: parsed.data });
  return error ? fail(mapDbError(error)) : ok(undefined);
}
