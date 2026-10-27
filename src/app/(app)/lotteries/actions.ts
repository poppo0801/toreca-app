"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  addManualPurchase,
  archiveLottery,
  currentHouseholdId,
  duplicateLottery,
  loadAppData,
  saveLottery,
  setApplied,
  setEventState,
  setFulfillment,
  setLotterySkip,
  setManaged,
  setResult,
  setItemResults,
  updateProfileSettings,
  type ProfileSettingsInput,
  type Db,
  type ServiceResult,
} from "@/lib/server/lottery-service";
import { deleteExpense, deleteSale, saveExpense, saveSale } from "@/lib/server/finance-service";
import type { ExpenseInput, SaleInput } from "@/lib/finance-input";
import type { LotteryInput } from "@/lib/lottery-input";
import type { ManualPurchaseInput } from "@/lib/purchase-input";
import type { AppData, EventState, FulfillmentStatus, ResultStatus } from "@/types/domain";

/** 更新系の戻り値。成功時は最新のスナップショットを返し、クライアントは再取得なしで反映する。 */
export type MutationResult = { ok: true; data: AppData; createdIds?: string[] } | { ok: false; error: string };

async function context(): Promise<{ db: Db; householdId: string } | null> {
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;
  const householdId = await currentHouseholdId(db);
  return householdId ? { db, householdId } : null;
}

async function mutate<T>(fn: (c: { db: Db; householdId: string }) => Promise<ServiceResult<T>>): Promise<MutationResult> {
  const c = await context();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const res = await fn(c);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const data = await loadAppData(c.db);
    revalidatePath("/lotteries");
    const v = res.value as { id?: string; ids?: string[] } | undefined;
    return { ok: true, data, createdIds: v?.ids ?? (v?.id ? [v.id] : undefined) };
  } catch {
    return { ok: false, error: "保存しましたが、最新データの取得に失敗しました。再読み込みしてください" };
  }
}

export async function loadAppDataAction(): Promise<{ ok: true; data: AppData } | { ok: false; error: string }> {
  const c = await context();
  if (!c) return { ok: false, error: "ログインが必要です" };
  try {
    return { ok: true, data: await loadAppData(c.db) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "データの取得に失敗しました" };
  }
}

export async function saveLotteryAction(id: string | null, input: LotteryInput, actor: string | null): Promise<MutationResult> {
  return mutate((c) => saveLottery(c.db, c.householdId, id, input, actor));
}

export async function duplicateLotteryAction(lotteryId: string, storeIds: string[], actor: string | null): Promise<MutationResult> {
  return mutate((c) => duplicateLottery(c.db, c.householdId, lotteryId, storeIds, actor));
}

export async function setEventStateAction(lotteryId: string, state: EventState, actor: string | null): Promise<MutationResult> {
  return mutate((c) => setEventState(c.db, lotteryId, state, actor));
}

export async function archiveLotteryAction(lotteryId: string, actor: string | null): Promise<MutationResult> {
  return mutate((c) => archiveLottery(c.db, lotteryId, actor));
}

export async function setManagedAction(lotteryId: string, isManaged: boolean, actor: string | null): Promise<MutationResult> {
  return mutate((c) => setManaged(c.db, c.householdId, lotteryId, isManaged, actor));
}

export async function setAppliedAction(
  lotteryId: string,
  accountId: string,
  applied: boolean,
  actor: string | null,
  selectedItemId: string | null = null,
): Promise<MutationResult> {
  return mutate((c) => setApplied(c.db, c.householdId, lotteryId, accountId, applied, actor, selectedItemId));
}

export async function setItemResultsAction(
  applicationId: string,
  results: { itemId: string; result: ResultStatus }[],
  actor: string | null,
): Promise<MutationResult> {
  return mutate((c) => setItemResults(c.db, applicationId, results, actor));
}

export async function saveExpenseAction(id: string | null, input: ExpenseInput, actor: string | null): Promise<MutationResult> {
  return mutate((c) => saveExpense(c.db, c.householdId, id, input, actor));
}
export async function deleteExpenseAction(id: string, actor: string | null): Promise<MutationResult> {
  return mutate((c) => deleteExpense(c.db, id, actor));
}
export async function saveSaleAction(id: string | null, input: SaleInput, actor: string | null): Promise<MutationResult> {
  return mutate((c) => saveSale(c.db, c.householdId, id, input, actor));
}
export async function deleteSaleAction(id: string, actor: string | null): Promise<MutationResult> {
  return mutate((c) => deleteSale(c.db, id, actor));
}
export async function updateProfileAction(profileId: string, input: ProfileSettingsInput, actor: string | null): Promise<MutationResult> {
  return mutate((c) => updateProfileSettings(c.db, profileId, input, actor));
}

export async function setResultAction(applicationId: string, result: ResultStatus, actor: string | null): Promise<MutationResult> {
  return mutate((c) => setResult(c.db, applicationId, result, actor));
}

export async function setFulfillmentAction(applicationId: string, fulfillment: FulfillmentStatus, actor: string | null): Promise<MutationResult> {
  return mutate((c) => setFulfillment(c.db, applicationId, fulfillment, actor));
}

export async function setLotterySkipAction(profileId: string, lotteryId: string, skip: boolean, actor: string | null): Promise<MutationResult> {
  return mutate((c) => setLotterySkip(c.db, c.householdId, profileId, lotteryId, skip, actor));
}

export async function addManualPurchaseAction(input: ManualPurchaseInput, actor: string | null): Promise<MutationResult> {
  return mutate((c) => addManualPurchase(c.db, c.householdId, input, actor));
}
