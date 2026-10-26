import {
  addManualPurchaseAction,
  archiveLotteryAction,
  duplicateLotteryAction,
  loadAppDataAction,
  saveLotteryAction,
  setAppliedAction,
  setEventStateAction,
  setFulfillmentAction,
  setLotterySkipAction,
  setManagedAction,
  setResultAction,
} from "@/app/(app)/lotteries/actions";
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
  setApplied = (actor: string, id: string, acc: string, v: boolean) => setAppliedAction(id, acc, v, actor);
  setResult = (actor: string, appId: string, r: Parameters<typeof setResultAction>[1]) => setResultAction(appId, r, actor);
  setFulfillment = (actor: string, appId: string, f: Parameters<typeof setFulfillmentAction>[1]) => setFulfillmentAction(appId, f, actor);
  setLotterySkip = (profileId: string, id: string, v: boolean) => setLotterySkipAction(profileId, id, v, profileId);
  setEventState = (actor: string, id: string, s: Parameters<typeof setEventStateAction>[1]) => setEventStateAction(id, s, actor);
  saveLottery = (actor: string, id: string | null, input: Parameters<typeof saveLotteryAction>[1]) => saveLotteryAction(id, input, actor);
  duplicateLottery = (actor: string, id: string, storeIds: string[]) => duplicateLotteryAction(id, storeIds, actor);
  archiveLottery = (actor: string, id: string) => archiveLotteryAction(id, actor);
  addManualPurchase = (actor: string, input: Parameters<typeof addManualPurchaseAction>[0]) => addManualPurchaseAction(input, actor);
}
