import { isPast } from "@/lib/datetime";
import type {
  AccountStatus,
  Application,
  AppData,
  Lottery,
  Profile,
  ServiceAccount,
} from "@/types/domain";

export interface JudgeResult {
  status: AccountStatus;
  reason: string;
}

/** 期限による実効イベント状態。期限超過でもデータは消さず、表示上だけ「受付終了」にする。 */
export function effectiveEventState(lottery: Lottery, now: Date): Lottery["eventState"] {
  if (lottery.eventState === "cancelled" || lottery.eventState === "postponed") {
    return lottery.eventState;
  }
  if (isPast(lottery.applyDeadline, now) === true) return "closed";
  if (lottery.eventState === "closed") return "closed";
  if (isPast(lottery.applyStart, now) === false && lottery.applyStart.precision !== "unknown") {
    return "before";
  }
  return lottery.eventState === "before" ? "before" : "open";
}

function activeApplications(data: AppData, lotteryId: string): Application[] {
  return data.applications.filter((a) => a.lotteryId === lotteryId && a.state === "applied");
}

/** プロフィールのスルー規則（抽選/店舗/系列）。今回だけの例外解除を考慮。 */
export function isSkippedBy(data: AppData, profileId: string, lottery: Lottery): boolean {
  return data.skipRules.some((r) => {
    if (r.profileId !== profileId) return false;
    if (r.exceptionLotteryIds.includes(lottery.id)) return false;
    return (
      (r.scope === "lottery" && r.scopeId === lottery.id) ||
      (r.scope === "store" && r.scopeId === lottery.storeId) ||
      (r.scope === "chain" && r.scopeId === lottery.chainId)
    );
  });
}

function inProfileScope(profile: Profile, chainId: string): boolean {
  if (profile.blockedChainIds.includes(chainId)) return false;
  if (profile.allowedChainIds !== null && !profile.allowedChainIds.includes(chainId)) return false;
  return true;
}

/**
 * 応募可能判定（architecture-decisions.md の6段階を単一関数に集約）。
 * UIバッジ・応募マトリクス・通知・完了率はすべてこの関数を使う。
 * 判定に迷う場合は保守的に needs_review とし、通知を確定発火しない。
 *
 * 注: 「応募済み」は表示上の事実なので最優先で返す（スルー済みでも応募記録は応募済みと見せる）。
 */
export function judgeAccount(
  data: AppData,
  lottery: Lottery,
  account: ServiceAccount,
  now: Date,
): JudgeResult {
  const mine = data.applications.find(
    (a) => a.lotteryId === lottery.id && a.accountId === account.id && a.state === "applied",
  );
  if (mine) return { status: "applied", reason: "応募済み" };

  // 1. 応募期間中か
  const event = effectiveEventState(lottery, now);
  if (event === "cancelled") return { status: "ineligible", reason: "中止" };
  if (event === "closed") return { status: "ineligible", reason: "受付終了" };
  if (event === "before") return { status: "ineligible", reason: "受付前" };

  // 2. プロフィールの対象範囲とアカウントの紐付け
  const profile = data.profiles.find((p) => p.id === account.profileId);
  if (!profile || !account.active) return { status: "ineligible", reason: "アカウント無効" };
  if (account.chainId !== lottery.chainId) return { status: "ineligible", reason: "系列対象外" };
  if (!inProfileScope(profile, lottery.chainId)) {
    return { status: "ineligible", reason: "プロフィールの対象外" };
  }

  // 3. スルー（プロフィール別。他プロフィールへは伝播しない）
  if (isSkippedBy(data, profile.id, lottery)) return { status: "skipped", reason: "スルー" };

  // 4. 会員資格・応募条件の確認度
  if (account.membership === "ineligible") return { status: "ineligible", reason: "資格なし" };
  if (account.membership === "unknown") return { status: "needs_review", reason: "会員資格が未確認" };

  // 5. 上限（抽選／キャンペーン／人物・家族・住所）
  const limitBasis = lottery.limit.basis;
  if (limitBasis === "unknown") return { status: "needs_review", reason: "応募制限が未確認" };

  const identity = data.identities.find((i) => i.id === account.identityId);
  if (!identity) return { status: "needs_review", reason: "名義が未設定" };

  const sameLottery = activeApplications(data, lottery.id);
  const accountOf = (a: Application) => data.accounts.find((x) => x.id === a.accountId);
  const identityOf = (a: Application) =>
    data.identities.find((i) => i.id === accountOf(a)?.identityId);

  const count = sameLottery.filter((a) => {
    const other = identityOf(a);
    if (!other) return false;
    switch (limitBasis) {
      case "account":
        return a.accountId === account.id;
      case "person":
        return other.id === identity.id;
      case "family":
        return other.familyGroupId === identity.familyGroupId;
      case "address":
        return other.addressGroupId === identity.addressGroupId;
    }
  }).length;
  if (count >= lottery.limit.maxCount) {
    return { status: "covered_by_limit", reason: "枠充足" };
  }

  // 同時開催キャンペーンの1店舗制限（店舗をまたいで判定）
  const campaign = data.campaigns.find((c) => c.id === lottery.campaignId);
  if (campaign?.storeRule === "one_store") {
    const siblingIds = data.lotteries
      .filter((l) => l.campaignId === campaign.id && l.id !== lottery.id)
      .map((l) => l.id);
    const appliedElsewhere = data.applications.some(
      (a) =>
        siblingIds.includes(a.lotteryId) &&
        a.state === "applied" &&
        identityOf(a)?.id === identity.id,
    );
    if (appliedElsewhere) return { status: "covered_by_limit", reason: "同キャンペーンで他店舗に応募済み" };
  }

  return { status: "eligible_unapplied", reason: "未応募" };
}

/** 抽選に関係するアカウント(系列一致・有効)を全プロフィール分返す */
export function accountsForLottery(data: AppData, lottery: Lottery): ServiceAccount[] {
  return data.accounts.filter((a) => a.chainId === lottery.chainId && a.active);
}
