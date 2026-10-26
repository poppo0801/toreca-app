import { createMockData } from "@/data/mock";
import * as m from "@/lib/mutations";
import type { LotteryRepository } from "@/services/types";
import type { AppData, Profile } from "@/types/domain";

/** ローカルモック。リロードで初期状態に戻る（架空データのみ）。 */
export class InMemoryRepository implements LotteryRepository {
  private data: AppData | null = null;

  /** realProfiles: Supabaseモード時の実プロフィール。デモ抽選データの A/B/C を実IDに差し替える */
  constructor(private readonly realProfiles?: Profile[]) {}

  async load(now: Date): Promise<AppData> {
    this.data ??= this.realProfiles ? withRealProfiles(createMockData(now), this.realProfiles) : createMockData(now);
    return this.data;
  }

  private apply(fn: (d: AppData) => AppData): AppData {
    if (!this.data) throw new Error("load() を先に呼んでください");
    this.data = fn(this.data);
    return this.data;
  }

  async setManaged(actorId: string, lotteryId: string, isManaged: boolean) {
    return this.apply((d) => m.setManaged(d, actorId, lotteryId, isManaged, new Date()));
  }

  async setApplied(actorId: string, lotteryId: string, accountId: string, applied: boolean) {
    return this.apply((d) => m.setApplied(d, actorId, lotteryId, accountId, applied, new Date()));
  }

  async setResult(actorId: string, applicationId: string, result: Parameters<typeof m.setResult>[3]) {
    return this.apply((d) => m.setResult(d, actorId, applicationId, result, new Date()));
  }

  async setFulfillment(
    actorId: string,
    applicationId: string,
    fulfillment: Parameters<typeof m.setFulfillment>[3],
  ) {
    return this.apply((d) => m.setFulfillment(d, actorId, applicationId, fulfillment, new Date()));
  }

  async setLotterySkip(profileId: string, lotteryId: string, skip: boolean) {
    return this.apply((d) => m.setLotterySkip(d, profileId, lotteryId, skip, new Date()));
  }
}

/**
 * デモ抽選データ内のプロフィール(pA/pB/pC)を、DB上の実プロフィールへ順番に対応付ける。
 * 実プロフィールが3件未満なら、足りない分のデモ応募アカウント・応募は除外する。
 */
export function withRealProfiles(data: AppData, real: Profile[]): AppData {
  const map = new Map<string, Profile>();
  data.profiles.forEach((demo, i) => {
    if (real[i]) map.set(demo.id, real[i]);
  });
  const keepAccount = (profileId: string) => map.has(profileId);
  const accounts = data.accounts
    .filter((a) => keepAccount(a.profileId))
    .map((a) => ({ ...a, profileId: map.get(a.profileId)!.id }));
  const accountIds = new Set(accounts.map((a) => a.id));
  return {
    ...data,
    profiles: data.profiles
      .filter((p) => map.has(p.id))
      .map((p) => {
        const r = map.get(p.id)!;
        // 許可/除外リストはデモ系列に対するものなのでデモ側を維持
        return { ...p, id: r.id, label: r.label, initial: r.initial, color: r.color };
      }),
    accounts,
    applications: data.applications.filter((a) => accountIds.has(a.accountId)),
    skipRules: data.skipRules
      .filter((r) => keepAccount(r.profileId))
      .map((r) => ({ ...r, profileId: map.get(r.profileId)!.id })),
  };
}
