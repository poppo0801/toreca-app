import type { ExpenseInput, SaleInput } from "@/lib/finance-input";
import type { ProfileSettingsInput } from "@/lib/server/lottery-service";
import type { LotteryInput } from "@/lib/lottery-input";
import type { ManualPurchaseInput } from "@/lib/purchase-input";
import type { AppData, EventState, FulfillmentStatus, ResultStatus } from "@/types/domain";

/** 更新系の結果。成功時は最新スナップショット、失敗時は利用者向けメッセージ。 */
export type Outcome = { ok: true; data: AppData; createdIds?: string[] } | { ok: false; error: string };

/**
 * データ層の境界。mock は InMemory（CI/デモ）、supabase は Server Action 経由で DB に保存する。
 * 実行プロフィール(actor)は監査ログ用。サーバー側は認証済みの世帯の範囲でのみ書き込む（RLS）。
 */
export interface LotteryRepository {
  /** 抽選の登録・編集・複製など、DB保存を伴う機能が使えるか（mockでは不可） */
  readonly persistent: boolean;
  load(now: Date): Promise<AppData>;
  setManaged(actorId: string, lotteryId: string, isManaged: boolean): Promise<Outcome>;
  setApplied(actorId: string, lotteryId: string, accountId: string, applied: boolean, selectedItemId?: string | null): Promise<Outcome>;
  setItemResults(actorId: string, applicationId: string, results: { itemId: string; result: ResultStatus }[]): Promise<Outcome>;
  saveExpense(actorId: string, id: string | null, input: ExpenseInput): Promise<Outcome>;
  deleteExpense(actorId: string, id: string): Promise<Outcome>;
  saveSale(actorId: string, id: string | null, input: SaleInput): Promise<Outcome>;
  deleteSale(actorId: string, id: string): Promise<Outcome>;
  updateProfile(actorId: string, profileId: string, input: ProfileSettingsInput): Promise<Outcome>;
  /** ユーザーの表示順（有効なユーザー全員をこの順に並べる）。応募・当落のデータには触れない */
  reorderProfiles(actorId: string, ids: string[]): Promise<Outcome>;
  setResult(actorId: string, applicationId: string, result: ResultStatus): Promise<Outcome>;
  setFulfillment(actorId: string, applicationId: string, fulfillment: FulfillmentStatus): Promise<Outcome>;
  setLotterySkip(profileId: string, lotteryId: string, skip: boolean): Promise<Outcome>;
  setEventState(actorId: string, lotteryId: string, state: EventState): Promise<Outcome>;
  saveLottery(actorId: string, id: string | null, input: LotteryInput): Promise<Outcome>;
  duplicateLottery(actorId: string, lotteryId: string, storeIds: string[]): Promise<Outcome>;
  archiveLottery(actorId: string, lotteryId: string): Promise<Outcome>;
  addManualPurchase(actorId: string, input: ManualPurchaseInput): Promise<Outcome>;
}

/** 端末(ブラウザ)単位のUI状態。サーバーや他端末とは同期しない（requirements 2.1）。 */
export interface DeviceStore {
  getProfileId(): string | null;
  setProfileId(id: string): void;
}
