import { createMockData } from "@/data/mock";
import * as m from "@/lib/mutations";
import type { LotteryRepository, Outcome } from "@/services/types";
import type { AppData } from "@/types/domain";

const UNSUPPORTED: Outcome = {
  ok: false,
  error: "この操作はSupabaseモード（ログイン後）でのみ利用できます",
};

/** ローカルモック。リロードで初期状態に戻る（架空データのみ）。CI/デモ用。 */
export class InMemoryRepository implements LotteryRepository {
  readonly persistent = false;
  private data: AppData | null = null;

  async load(now: Date): Promise<AppData> {
    this.data ??= createMockData(now);
    return this.data;
  }

  private apply(fn: (d: AppData) => AppData): Outcome {
    if (!this.data) throw new Error("load() を先に呼んでください");
    this.data = fn(this.data);
    return { ok: true, data: this.data };
  }

  async setManaged(actorId: string, lotteryId: string, isManaged: boolean) {
    return this.apply((d) => m.setManaged(d, actorId, lotteryId, isManaged, new Date()));
  }
  async setApplied(actorId: string, lotteryId: string, accountId: string, applied: boolean) {
    // 応募状態を変えられるのは、操作中のプロフィール自身のアカウントだけ（他のプロフィールは閲覧のみ）
    const acc = this.data?.accounts.find((a) => a.id === accountId);
    if (acc && acc.profileId !== actorId) return { ok: false as const, error: "他のユーザーの応募状況は変更できません" };
    return this.apply((d) => m.setApplied(d, actorId, lotteryId, accountId, applied, new Date()));
  }
  async setResult(actorId: string, applicationId: string, result: Parameters<typeof m.setResult>[3]) {
    return this.apply((d) => m.setResult(d, actorId, applicationId, result, new Date()));
  }
  async setFulfillment(actorId: string, applicationId: string, fulfillment: Parameters<typeof m.setFulfillment>[3]) {
    return this.apply((d) => m.setFulfillment(d, actorId, applicationId, fulfillment, new Date()));
  }
  async setLotterySkip(profileId: string, lotteryId: string, skip: boolean) {
    return this.apply((d) => m.setLotterySkip(d, profileId, lotteryId, skip, new Date()));
  }
  async setEventState(actorId: string, lotteryId: string, state: Parameters<typeof m.setEventState>[3]) {
    return this.apply((d) => m.setEventState(d, actorId, lotteryId, state, new Date()));
  }
  async setItemResults() {
    return UNSUPPORTED;
  }
  async saveExpense() {
    return UNSUPPORTED;
  }
  async deleteExpense() {
    return UNSUPPORTED;
  }
  async saveSale() {
    return UNSUPPORTED;
  }
  async deleteSale() {
    return UNSUPPORTED;
  }
  async reorderProfiles(_actorId: string, ids: string[]) {
    return this.apply((d) => ({ ...d, profiles: [...d.profiles].sort((a, b) => (ids.indexOf(a.id) + 1 || 999) - (ids.indexOf(b.id) + 1 || 999)) }));
  }
  async updateProfile() {
    return UNSUPPORTED;
  }
  async saveLottery() {
    return UNSUPPORTED;
  }
  async duplicateLottery() {
    return UNSUPPORTED;
  }
  async archiveLottery() {
    return UNSUPPORTED;
  }
  async addManualPurchase() {
    return UNSUPPORTED;
  }
}
