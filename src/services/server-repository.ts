import {
  addManualPurchaseAction,
  archiveLotteryAction,
  duplicateLotteryAction,
  saveLotteryAndDuplicateAction,
  lotteryOperationResultAction,
  excludeLotteryAction,
  groupLotteriesAction,
  ungroupLotteryAction,
  dissolveLotteryGroupAction,
  loadAppDataAction,
  saveLotteryAction,
  setAppliedAction,
  setAppliedStoreAction,
  setEventStateAction,
  setFulfillmentAction,
  revertFulfillmentAction,
  setLotterySkipAction,
  setManagedAction,
  setResultAction,
  setItemResultsAction,
  setAppliedItemsAction,
  saveExpenseAction,
  deleteExpenseAction,
  saveSaleAction,
  deleteSaleAction,
  updateProfileAction,
  reorderProfilesAction,
} from "@/app/(app)/lotteries/actions";
import type { ApplyOptions } from "@/lib/server/lottery-service";
import type { LotteryRepository } from "@/services/types";

/** Supabase 実装。すべて Server Action 経由（サーバーで検証し、RLS下で保存）。 */
export class ServerActionRepository implements LotteryRepository {
  readonly persistent = true;

  async load() {
    const res = await loadAppDataAction();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }
  setManaged = (actor: string, id: string, v: boolean) => setManagedAction(id, v, actor);
  setApplied = (actor: string, id: string, acc: string, v: boolean, selected: string | null = null, opts: ApplyOptions = {}) => setAppliedAction(id, acc, v, actor, selected, opts);
  setItemResults = (actor: string, appId: string, results: Parameters<typeof setItemResultsAction>[1]) => setItemResultsAction(appId, results, actor);
  setAppliedItems = (actor: string, appId: string, itemIds: string[]) => setAppliedItemsAction(appId, itemIds, actor);
  saveExpense = (actor: string, id: string | null, input: Parameters<typeof saveExpenseAction>[1]) => saveExpenseAction(id, input, actor);
  deleteExpense = (actor: string, id: string) => deleteExpenseAction(id, actor);
  saveSale = (actor: string, id: string | null, input: Parameters<typeof saveSaleAction>[1]) => saveSaleAction(id, input, actor);
  deleteSale = (actor: string, id: string) => deleteSaleAction(id, actor);
  reorderProfiles = (actor: string, ids: string[]) => reorderProfilesAction(ids, actor);
  updateProfile = (actor: string, profileId: string, input: Parameters<typeof updateProfileAction>[1]) => updateProfileAction(profileId, input, actor);
  setAppliedStore = (actor: string, appId: string, store: { id: string | null; name: string; prefecture: string } | null) => setAppliedStoreAction(appId, store, actor);
  setResult = (actor: string, appId: string, r: Parameters<typeof setResultAction>[1]) => setResultAction(appId, r, actor);
  setFulfillment = (actor: string, appId: string, f: Parameters<typeof setFulfillmentAction>[1]) => setFulfillmentAction(appId, f, actor);
  revertFulfillment = (actor: string, appId: string, to: "none" | "procedure_done") => revertFulfillmentAction(appId, to, actor);
  setLotterySkip = (profileId: string, id: string, v: boolean) => setLotterySkipAction(profileId, id, v, profileId);
  setEventState = (actor: string, id: string, s: Parameters<typeof setEventStateAction>[1]) => setEventStateAction(id, s, actor);
  saveLottery = (actor: string, id: string | null, input: Parameters<typeof saveLotteryAction>[1]) => saveLotteryAction(id, input, actor);
  duplicateLottery = (actor: string, id: string, storeIds: string[], opts?: Parameters<typeof duplicateLotteryAction>[3]) => duplicateLotteryAction(id, storeIds, actor, opts);
  saveLotteryAndDuplicate = (actor: string, input: Parameters<typeof saveLotteryAction>[1], storeIds: string[], newStores: { name: string; prefecture: string }[], opId: string) => saveLotteryAndDuplicateAction(input, storeIds, newStores, actor, opId);
  lotteryOperationResult = (opId: string) => lotteryOperationResultAction(opId);
  archiveLottery = (actor: string, id: string) => archiveLotteryAction(id, actor);
  excludeLottery = (actor: string, id: string, ex: Parameters<typeof excludeLotteryAction>[1]) => excludeLotteryAction(id, ex, actor);
  groupLotteries = (actor: string, ids: string[], opts: Parameters<typeof groupLotteriesAction>[1] = {}) => groupLotteriesAction(ids, opts, actor);
  ungroupLottery = (actor: string, id: string) => ungroupLotteryAction(id, actor);
  dissolveLotteryGroup = (actor: string, id: string) => dissolveLotteryGroupAction(id, actor);
  addManualPurchase = (actor: string, input: Parameters<typeof addManualPurchaseAction>[0]) => addManualPurchaseAction(input, actor);
}
