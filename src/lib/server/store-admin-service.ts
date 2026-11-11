import { z } from "zod";
import { storeAdminErrorText, type StoreRefCounts } from "@/lib/store-admin";
import type { Db, ServiceResult } from "@/lib/server/lottery-service";

/** 店舗マスターの削除・統合（Stage 7S）。実体は DB 関数（1トランザクション・照合つき）。参照のある店舗は削除しない（連鎖削除はしない） */
const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
const fail = (error: string): ServiceResult<never> => ({ ok: false, error });
const uuid = z.uuid();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しいRPCは生成型に無い場合がある
const any = (db: Db) => db as any;

export async function storeReferences(db: Db, storeId: string): Promise<ServiceResult<StoreRefCounts>> {
  if (!uuid.safeParse(storeId).success) return fail("リクエストが不正です");
  const { data, error } = await any(db).rpc("store_reference_counts", { p_id: storeId });
  return error ? fail(storeAdminErrorText(error.message ?? "調査に失敗しました")) : ok(data as StoreRefCounts);
}

export async function deleteStore(db: Db, storeId: string): Promise<ServiceResult> {
  if (!uuid.safeParse(storeId).success) return fail("リクエストが不正です");
  const { error } = await any(db).rpc("delete_store", { p_id: storeId });
  return error ? fail(storeAdminErrorText(error.message ?? "削除に失敗しました")) : ok(undefined);
}

export async function mergeStores(db: Db, fromId: string, intoId: string, actor: string | null): Promise<ServiceResult<{ lotteries: number }>> {
  if (!uuid.safeParse(fromId).success || !uuid.safeParse(intoId).success) return fail("リクエストが不正です");
  const { data, error } = await any(db).rpc("merge_store_masters", { p_from: fromId, p_into: intoId, p_actor: actor });
  return error ? fail(storeAdminErrorText(error.message ?? "統合に失敗しました")) : ok({ lotteries: Number(data?.lotteries ?? 0) });
}
