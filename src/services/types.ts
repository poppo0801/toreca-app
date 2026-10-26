import type { AppData, FulfillmentStatus, ResultStatus } from "@/types/domain";

/**
 * データ層の境界。Stage 0 は InMemory（ローカルモック）、Stage 1 で Supabase 実装に差し替える。
 * 更新系は変更後のスナップショットを返す。実行プロフィール(actor)は監査ログ用に必須。
 * Supabase 版では actor を鵜呑みにせず、認証済みの世帯(household)の範囲でのみ書き込むこと。
 */
export interface LotteryRepository {
  load(now: Date): Promise<AppData>;
  setManaged(actorId: string, lotteryId: string, isManaged: boolean): Promise<AppData>;
  setApplied(actorId: string, lotteryId: string, accountId: string, applied: boolean): Promise<AppData>;
  setResult(actorId: string, applicationId: string, result: ResultStatus): Promise<AppData>;
  setFulfillment(
    actorId: string,
    applicationId: string,
    fulfillment: FulfillmentStatus,
  ): Promise<AppData>;
  setLotterySkip(profileId: string, lotteryId: string, skip: boolean): Promise<AppData>;
}

/** 端末(ブラウザ)単位のUI状態。サーバーや他端末とは同期しない（requirements 2.1）。 */
export interface DeviceStore {
  getProfileId(): string | null;
  setProfileId(id: string): void;
}
