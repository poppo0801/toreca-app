import type { ExpenseInput, SaleInput } from "@/lib/finance-input";
import type { ApplyOptions, ProfileSettingsInput } from "@/lib/server/lottery-service";
import type { LotteryInput } from "@/lib/lottery-input";
import type { ManualPurchaseInput } from "@/lib/purchase-input";
import type { AppData, EventState, FulfillmentStatus, ResultStatus } from "@/types/domain";

/** 更新系の結果。成功時は最新スナップショット、失敗時は利用者向けメッセージ。 */
export type Outcome = { ok: true; data: AppData; createdIds?: string[]; /** 複製で、同じ内容がすでにあるため作らなかった店舗 */ skipped?: { storeName: string; reason: string }[]; groupId?: string | null } | { ok: false; error: string };

/**
 * データ層の境界。mock は InMemory（CI/デモ）、supabase は Server Action 経由で DB に保存する。
 * 実行プロフィール(actor)は監査ログ用。サーバー側は認証済みの世帯の範囲でのみ書き込む（RLS）。
 */
export interface LotteryRepository {
  /** 抽選の登録・編集・複製など、DB保存を伴う機能が使えるか（mockでは不可） */
  readonly persistent: boolean;
  load(now: Date): Promise<AppData>;
  setManaged(actorId: string, lotteryId: string, isManaged: boolean): Promise<Outcome>;
  setApplied(actorId: string, lotteryId: string, accountId: string, applied: boolean, selectedItemId?: string | null, opts?: ApplyOptions): Promise<Outcome>;
  setItemResults(actorId: string, applicationId: string, results: { itemId: string; result: ResultStatus }[]): Promise<Outcome>;
  setAppliedItems(actorId: string, applicationId: string, itemIds: string[]): Promise<Outcome>;
  saveExpense(actorId: string, id: string | null, input: ExpenseInput): Promise<Outcome>;
  deleteExpense(actorId: string, id: string): Promise<Outcome>;
  saveSale(actorId: string, id: string | null, input: SaleInput): Promise<Outcome>;
  deleteSale(actorId: string, id: string): Promise<Outcome>;
  updateProfile(actorId: string, profileId: string, input: ProfileSettingsInput): Promise<Outcome>;
  /** ユーザーの表示順（有効なユーザー全員をこの順に並べる）。応募・当落のデータには触れない */
  reorderProfiles(actorId: string, ids: string[]): Promise<Outcome>;
  setResult(actorId: string, applicationId: string, result: ResultStatus): Promise<Outcome>;
  /** 応募店舗の変更（店舗選択式の抽選）。null で未設定に戻す */
  setAppliedStore(actorId: string, applicationId: string, store: { id: string | null; name: string; prefecture: string } | null): Promise<Outcome>;
  setFulfillment(actorId: string, applicationId: string, fulfillment: FulfillmentStatus): Promise<Outcome>;
  /** 直前に記録した購入手続き／受取の取り消し（Undo用）。受取済みで自動作成された購入記録も戻す */
  revertFulfillment(actorId: string, applicationId: string, to: "none" | "procedure_done"): Promise<Outcome>;
  setLotterySkip(profileId: string, lotteryId: string, skip: boolean): Promise<Outcome>;
  setEventState(actorId: string, lotteryId: string, state: EventState): Promise<Outcome>;
  saveLottery(actorId: string, id: string | null, input: LotteryInput): Promise<Outcome>;
  duplicateLottery(actorId: string, lotteryId: string, storeIds: string[], opts?: import("@/lib/server/lottery-service").DuplicateOptions): Promise<Outcome>;
  /** 新規登録して他店舗へ複製（保存して複製）。失敗時は保存した元も取り消す */
  saveLotteryAndDuplicate(actorId: string, input: LotteryInput, storeIds: string[], newStores: { name: string; prefecture: string }[]): Promise<Outcome>;
  archiveLottery(actorId: string, lotteryId: string): Promise<Outcome>;
  /** 登録済み抽選の除外（理由つき）。物理削除はしない */
  excludeLottery(actorId: string, lotteryId: string, ex: import("@/lib/server/lottery-service").ExclusionInput): Promise<Outcome>;
  /** 抽選グループ（複数店舗抽選の表示グループ）。応募・当選の記録は変えない */
  groupLotteries(actorId: string, lotteryIds: string[], opts?: import("@/lib/server/lottery-service").GroupOptions): Promise<Outcome>;
  ungroupLottery(actorId: string, lotteryId: string): Promise<Outcome>;
  dissolveLotteryGroup(actorId: string, groupId: string): Promise<Outcome>;
  addManualPurchase(actorId: string, input: ManualPurchaseInput): Promise<Outcome>;
}

/** 端末(ブラウザ)単位のUI状態。サーバーや他端末とは同期しない（requirements 2.1）。 */
export interface DeviceStore {
  getProfileId(): string | null;
  setProfileId(id: string): void;
}
