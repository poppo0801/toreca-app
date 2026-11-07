import { z } from "zod";
import { chainMergeErrorText as mergeErrorText, type ChainRefCounts as RefCounts } from "@/lib/chain-merge";
import type { Db, ServiceResult } from "@/lib/server/lottery-service";

/**
 * 系列マスターの削除・統合（Stage 6Q）。実体は DB 関数（1トランザクション・冪等・照合つき）。認証済み(RLS)のクライアントを受け取る。
 * 参照のある系列は削除せず（連鎖削除はしない）、統合は履歴を残したまま参照先だけを付け替える。
 */
const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
const fail = (error: string): ServiceResult<never> => ({ ok: false, error });
const uuid = z.uuid();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しいRPCは生成型に無い場合がある
const any = (db: Db) => db as any;

export async function chainReferences(db: Db, chainId: string): Promise<ServiceResult<RefCounts>> {
  if (!uuid.safeParse(chainId).success) return fail("リクエストが不正です");
  const { data, error } = await any(db).rpc("chain_reference_counts", { p_id: chainId });
  return error ? fail(mergeErrorText(error.message ?? "調査に失敗しました")) : ok(data as RefCounts);
}

export async function deleteChain(db: Db, chainId: string): Promise<ServiceResult> {
  if (!uuid.safeParse(chainId).success) return fail("リクエストが不正です");
  const { error } = await any(db).rpc("delete_chain", { p_id: chainId });
  return error ? fail(mergeErrorText(error.message ?? "削除に失敗しました")) : ok(undefined);
}

export interface ChainMergePreview {
  from: RefCounts;
  into: RefCounts;
}

/** 統合の確認用（何も変更しない）。コード・区分・パック数の食い違いはここで拒否される */
export async function previewChainMerge(db: Db, fromId: string, intoId: string, actor: string | null): Promise<ServiceResult<ChainMergePreview & { already?: boolean }>> {
  if (!uuid.safeParse(fromId).success || !uuid.safeParse(intoId).success) return fail("リクエストが不正です");
  const { data, error } = await any(db).rpc("merge_chain_masters", { p_from: fromId, p_into: intoId, p_actor: actor, p_execute: false });
  if (error) return fail(mergeErrorText(error.message ?? "確認に失敗しました"));
  if (data?.already) return ok({ already: true, from: {}, into: {} });
  return ok({ from: data.from as RefCounts, into: data.into as RefCounts });
}

export interface ChainMergeResult {
  already?: boolean;
  stores_moved?: number;
  stores_merged?: number;
  applications_repointed?: number;
  lotteries?: number;
  purchases?: number;
  box_lots?: number;
}

export async function mergeChains(db: Db, fromId: string, intoId: string, actor: string | null): Promise<ServiceResult<ChainMergeResult>> {
  if (!uuid.safeParse(fromId).success || !uuid.safeParse(intoId).success) return fail("リクエストが不正です");
  const { data, error } = await any(db).rpc("merge_chain_masters", { p_from: fromId, p_into: intoId, p_actor: actor, p_execute: true });
  return error ? fail(mergeErrorText(error.message ?? "統合に失敗しました")) : ok(data as ChainMergeResult);
}
