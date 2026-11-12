"use server";

// 更新系は最新のデータをそのまま返し、画面は自分の状態を更新する。revalidatePath はページ全体の再描画（認証・世帯準備のRPCを含む）と、全リンクの先読みの取り直しを起こすため使わない（Stage 7O）
import { createClient } from "@/lib/supabase/server";
import {
  addManualPurchase,
  archiveLottery,
  currentHouseholdId,
  duplicateLottery,
  excludeLottery,
  groupLotteries,
  ungroupLottery,
  dissolveLotteryGroup,
  saveLotteryAndDuplicate,
  lotteryOperationResult,
  type DuplicateOptions,
  type ExclusionInput,
  type GroupOptions,
  loadAppData,
  saveLottery,
  saveLotteryBulk,
  setApplied,
  setAppliedStore,
  type ApplyOptions,
  setEventState,
  setFulfillment,
  revertFulfillment,
  setLotterySkip,
  setManaged,
  setResult,
  setItemResults,
  setAppliedItems,
  acknowledgeCautions,
  updateProfileSettings,
  reorderProfiles,
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
export type MutationResult = { ok: true; data: AppData; createdIds?: string[]; /** 店舗別の一括登録で、登録済みのため対象から除いた店舗 */ skipped?: { storeName: string; reason: string }[]; /** 作成・変更した抽選グループ */ groupId?: string | null } | { ok: false; error: string };

async function context(): Promise<{ db: Db; householdId: string } | null> {
  const db = (await createClient()) as unknown as Db;
  // ログインの確認と世帯の取得は互いに独立（世帯はRLSで自分の世帯だけが返る）。順番に待たず同時に行う（Stage 7O）
  const [{ data: auth }, householdId] = await Promise.all([db.auth.getUser(), currentHouseholdId(db)]);
  if (!auth.user) return null;
  return householdId ? { db, householdId } : null;
}

/**
 * 読み取り専用の取得用。署名つきのトークン（JWT）をサーバー内で検証し、認証サーバーへの問い合わせ（getUser）を省く。
 * 実際のデータの認可は、各クエリのRLS（DB側でJWTを検証）が担うため、読み取りの安全性は変わらない。更新系は従来どおり getUser で確認する。
 */
async function readContext(): Promise<{ db: Db } | null> {
  const db = (await createClient()) as unknown as Db;
  const { data } = await db.auth.getClaims();
  return data?.claims ? { db } : null;
}

async function mutate<T>(fn: (c: { db: Db; householdId: string }) => Promise<ServiceResult<T>>): Promise<MutationResult> {
  const c = await context();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const res = await fn(c);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const data = await loadAppData(c.db);
    const v = res.value as { id?: string; ids?: string[] } | undefined;
    return { ok: true, data, createdIds: v?.ids ?? (v?.id ? [v.id] : undefined) };
  } catch {
    return { ok: false, error: "保存しましたが、最新データの取得に失敗しました。再読み込みしてください" };
  }
}

export async function loadAppDataAction(): Promise<{ ok: true; data: AppData } | { ok: false; error: string }> {
  const c = await readContext();
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

/** 店舗別の一括登録。opId は画面の1回の操作ごとに発行し、再送・再実行でも二重に登録しない */
export async function saveLotteryBulkAction(inputs: LotteryInput[], opId: string, candidateId: string | null, actor: string | null): Promise<MutationResult> {
  const c = await context();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const res = await saveLotteryBulk(c.db, inputs, opId, candidateId, actor);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const data = await loadAppData(c.db);
    return { ok: true, data, createdIds: res.value.ids, skipped: res.value.skipped };
  } catch {
    return { ok: false, error: "登録しましたが、最新データの取得に失敗しました。再読み込みしてください" };
  }
}

/** 自動収集の対象地域（都道府県）。店舗別の一括登録で、対象地域内の店舗を初期選択するために使う */
export async function loadCollectionAreaAction(): Promise<{ ok: true; prefectures: string[] } | { ok: false }> {
  const c = await context();
  if (!c) return { ok: false };
  const { data } = await c.db.from("collection_settings").select("prefectures").limit(1).maybeSingle();
  return data ? { ok: true, prefectures: (data.prefectures as string[] | null) ?? [] } : { ok: false };
}

/** 他店舗への複製（店舗の追加・グループ化を含む。1トランザクション） */
export async function duplicateLotteryAction(lotteryId: string, storeIds: string[], actor: string | null, opts: DuplicateOptions = {}): Promise<MutationResult> {
  const c = await context();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const res = await duplicateLottery(c.db, c.householdId, lotteryId, storeIds, actor, opts);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    return { ok: true, data: await loadAppData(c.db), createdIds: res.value.ids, skipped: res.value.skipped, groupId: res.value.groupId };
  } catch {
    return { ok: false, error: "複製しましたが、最新データの取得に失敗しました。再読み込みしてください" };
  }
}

/** 新規登録して他店舗へ複製（保存して複製）。複製に失敗したら、保存した元の抽選も取り消す */
export async function saveLotteryAndDuplicateAction(input: LotteryInput, storeIds: string[], newStores: { name: string; prefecture: string }[], actor: string | null, opId: string): Promise<MutationResult> {
  const c = await context();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const res = await saveLotteryAndDuplicate(c.db, c.householdId, input, storeIds, newStores, actor, opId);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    return { ok: true, data: await loadAppData(c.db), createdIds: [res.value.lotteryId, ...res.value.ids], skipped: res.value.skipped, groupId: res.value.groupId };
  } catch {
    return { ok: false, error: "保存しましたが、最新データの取得に失敗しました。再読み込みしてください" };
  }
}

/** 保存して複製・他店舗に複製の結果の確認（操作ID）。通信が途切れて結果が分からないときに使う。found=false は、実行されていない（または失敗してロールバックされた） */
export async function lotteryOperationResultAction(opId: string): Promise<{ ok: true; found: boolean; result?: { ids: string[]; lotteryId?: string } } | { ok: false; error: string }> {
  const c = await readContext();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const r = await lotteryOperationResult(c.db, opId);
  if (!r.ok) return { ok: false, error: r.error };
  return r.value ? { ok: true, found: true, result: { ids: r.value.ids, lotteryId: r.value.lotteryId } } : { ok: true, found: false };
}

/** 登録済み抽選の除外（理由つき。物理削除はしない） */
export async function excludeLotteryAction(lotteryId: string, ex: ExclusionInput, actor: string | null): Promise<MutationResult> {
  return mutate((c) => excludeLottery(c.db, lotteryId, ex, actor));
}

export async function groupLotteriesAction(lotteryIds: string[], opts: GroupOptions, actor: string | null): Promise<MutationResult> {
  const c = await context();
  if (!c) return { ok: false, error: "ログインが必要です" };
  const res = await groupLotteries(c.db, lotteryIds, opts, actor);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    return { ok: true, data: await loadAppData(c.db), groupId: res.value.groupId };
  } catch {
    return { ok: false, error: "グループ化しましたが、最新データの取得に失敗しました。再読み込みしてください" };
  }
}
export async function ungroupLotteryAction(lotteryId: string, actor: string | null): Promise<MutationResult> {
  return mutate((c) => ungroupLottery(c.db, lotteryId, actor));
}
export async function dissolveLotteryGroupAction(groupId: string, actor: string | null): Promise<MutationResult> {
  return mutate((c) => dissolveLotteryGroup(c.db, groupId, actor));
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
  opts: ApplyOptions = {},
): Promise<MutationResult> {
  return mutate((c) => setApplied(c.db, c.householdId, lotteryId, accountId, applied, actor, selectedItemId, opts));
}

export async function setAppliedStoreAction(applicationId: string, store: { id: string | null; name: string; prefecture: string } | null, actor: string | null): Promise<MutationResult> {
  return mutate((c) => setAppliedStore(c.db, applicationId, store, actor));
}

export async function revertFulfillmentAction(applicationId: string, to: "none" | "procedure_done", actor: string | null): Promise<MutationResult> {
  return mutate((c) => revertFulfillment(c.db, applicationId, to, actor));
}

export async function setAppliedItemsAction(applicationId: string, itemIds: string[], actor: string | null): Promise<MutationResult> {
  return mutate((c) => setAppliedItems(c.db, applicationId, itemIds, actor));
}

/** 要確認を確認済みにする（表示中の注意のコードをまとめて解除。状態はDBに保存） */
export async function acknowledgeCautionsAction(lotteryId: string, codes: string[]): Promise<MutationResult> {
  return mutate((c) => acknowledgeCautions(c.db, lotteryId, codes));
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
export async function reorderProfilesAction(ids: string[], actor: string | null): Promise<MutationResult> {
  return mutate((c) => reorderProfiles(c.db, ids, actor));
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
