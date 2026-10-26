import { isPast, jstDateString } from "@/lib/datetime";
import type {
  AccountStatus,
  Application,
  AppData,
  Identity,
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

export type SkipSource = "lottery" | "store" | "chain";

/**
 * プロフィールのスルー規則（今回だけ=抽選 / 店舗単位 / 系列単位）。今回だけの例外解除を考慮。
 * 該当する最も狭い範囲を返す（なし=スルーされていない）。★管理とは独立。
 */
export function skipSourceFor(data: AppData, profileId: string, lottery: Lottery): SkipSource | null {
  const rules = data.skipRules.filter((r) => r.profileId === profileId && !r.exceptionLotteryIds.includes(lottery.id));
  if (rules.some((r) => r.scope === "lottery" && r.scopeId === lottery.id)) return "lottery";
  if (rules.some((r) => r.scope === "store" && r.scopeId === lottery.storeId)) return "store";
  if (rules.some((r) => r.scope === "chain" && r.scopeId === lottery.chainId)) return "chain";
  return null;
}

export function isSkippedBy(data: AppData, profileId: string, lottery: Lottery): boolean {
  return skipSourceFor(data, profileId, lottery) !== null;
}

/** 常時スルー（店舗・系列）に対して、この抽選だけ例外解除されているか */
export function hasSkipException(data: AppData, profileId: string, lottery: Lottery): boolean {
  return data.skipRules.some(
    (r) =>
      r.profileId === profileId &&
      r.exceptionLotteryIds.includes(lottery.id) &&
      ((r.scope === "store" && r.scopeId === lottery.storeId) || (r.scope === "chain" && r.scopeId === lottery.chainId)),
  );
}

/**
 * プロフィールの対象範囲。blocked は常に除外。
 * 許可リスト方式: 許可された系列または店舗のみ対象。許可の指定が何もなければ全体が対象。
 */
export function inProfileScope(profile: Profile, chainId: string, storeId: string): boolean {
  if (profile.blockedChainIds.includes(chainId) || profile.blockedStoreIds.includes(storeId)) return false;
  const allowMode = profile.allowedChainIds !== null || profile.allowedStoreIds.length > 0;
  if (!allowMode) return true;
  return !!profile.allowedChainIds?.includes(chainId) || profile.allowedStoreIds.includes(storeId);
}

// ------------------------------------------------------------------ 応募制限
export type RuleSource = "lottery" | "campaign" | "chain";
export interface EffectiveRule {
  basis: "account" | "person" | "family" | "address";
  maxCount: number;
  across: "lottery" | "campaign";
  source: RuleSource;
  confidence: "confirmed" | "unconfirmed";
}

const BASIS_LABEL = { account: "1アカウント", person: "1人", family: "1家族", address: "1住所" } as const;
const SOURCE_LABEL: Record<RuleSource, string> = { lottery: "抽選固有", campaign: "キャンペーン", chain: "系列標準" };

export function describeRule(r: EffectiveRule): string {
  const scope = r.across === "campaign" ? "（キャンペーン通算）" : "";
  return `${BASIS_LABEL[r.basis]}${r.maxCount}回${scope}・${SOURCE_LABEL[r.source]}${r.confidence === "unconfirmed" ? "・未確認" : ""}`;
}

/**
 * 抽選に適用される応募制限。
 *  - 抽選固有（lotteries の制限 + 抽選スコープのルール）があれば、系列標準は適用しない（上書き）。
 *  - キャンペーンのルール（および「1店舗まで」）は常に併用する。
 *  - 同じ (basis, across) は 抽選固有 > キャンペーン > 系列標準 の順で1つにまとめる。異なるものは併用（すべて満たす）。
 */
export function effectiveRules(data: AppData, lottery: Lottery): EffectiveRule[] {
  const own: EffectiveRule[] = [];
  if (lottery.limit.basis !== "unknown") {
    own.push({ basis: lottery.limit.basis, maxCount: lottery.limit.maxCount, across: "lottery", source: "lottery", confidence: "confirmed" });
  }
  const fromRules = (scope: RuleSource, id: string | undefined, source: RuleSource): EffectiveRule[] =>
    id
      ? data.applicationRules
          .filter((r) => r.scope === scope && r.scopeId === id)
          .map((r) => ({ basis: r.basis, maxCount: r.maxCount, across: r.across, source, confidence: r.confidence }))
      : [];
  own.push(...fromRules("lottery", lottery.id, "lottery"));

  const campaign = data.campaigns.find((c) => c.id === lottery.campaignId);
  const campaignRules = fromRules("campaign", lottery.campaignId, "campaign");
  if (campaign?.storeRule === "one_store" && !campaignRules.some((r) => r.basis === "person" && r.across === "campaign")) {
    campaignRules.push({ basis: "person", maxCount: 1, across: "campaign", source: "campaign", confidence: "confirmed" });
  }

  const chainRules = own.length > 0 ? [] : fromRules("chain", lottery.chainId, "chain");

  const merged = new Map<string, EffectiveRule>();
  for (const r of [...chainRules, ...campaignRules, ...own]) merged.set(`${r.basis}/${r.across}`, r); // 後勝ち=より具体的
  return [...merged.values()];
}

function sameBasis(basis: EffectiveRule["basis"], a: ServiceAccount, ai: Identity, b: ServiceAccount, bi: Identity): boolean {
  switch (basis) {
    case "account":
      return a.id === b.id;
    case "person":
      return ai.id === bi.id;
    case "family":
      return ai.familyGroupId === bi.familyGroupId;
    case "address":
      return ai.addressGroupId === bi.addressGroupId;
  }
}

function isExempt(data: AppData, lotteryId: string, accountId: string): boolean {
  return data.limitExemptions.some((e) => e.lotteryId === lotteryId && e.accountId === accountId);
}

// ------------------------------------------------------------------ 応募資格
/** 系列の応募条件に対するアカウントの資格。不明・期限切れ・未登録は「要確認」。 */
function judgeRequirements(data: AppData, account: ServiceAccount, now: Date): JudgeResult | null {
  const reqs = data.requirements.filter((r) => r.chainId === account.chainId);
  if (reqs.length === 0) return null;
  const today = jstDateString(now);
  let review: JudgeResult | null = null;
  for (const req of reqs) {
    const e = data.eligibilities.find((x) => x.accountId === account.id && x.requirementId === req.id);
    if (!e) review ??= { status: "needs_review", reason: `資格が未確認（${req.label}）` };
    else if (e.state === "ineligible") return { status: "ineligible", reason: `資格なし（${req.label}）` };
    else if (e.state === "unknown") review ??= { status: "needs_review", reason: `資格が未確認（${req.label}）` };
    else if (e.validUntil && e.validUntil < today) review ??= { status: "needs_review", reason: `資格の有効期限切れ（${req.label}）` };
  }
  return review;
}

function activeApplications(data: AppData, lotteryIds: string[]): Application[] {
  return data.applications.filter((a) => a.state === "applied" && lotteryIds.includes(a.lotteryId));
}

/**
 * 応募可能判定（architecture-decisions.md の6段階を単一関数に集約）。
 * UIバッジ・応募マトリクス・通知・完了率はすべてこの関数を使う。
 * 判定に迷う場合は保守的に needs_review とし、通知を確定発火しない。
 *
 * 注: 「応募済み」は表示上の事実なので最優先で返す（スルー済みでも応募記録は応募済みと見せる）。
 */
export function judgeAccount(data: AppData, lottery: Lottery, account: ServiceAccount, now: Date): JudgeResult {
  const mine = data.applications.find(
    (a) => a.lotteryId === lottery.id && a.accountId === account.id && a.state === "applied",
  );
  if (mine) return { status: "applied", reason: "応募済み" };

  // 1. 応募期間中か（受付前・受付終了・中止は「応募不可」。対象外とは区別する）
  const event = effectiveEventState(lottery, now);
  if (event === "cancelled") return { status: "unavailable", reason: "中止" };
  if (event === "closed") return { status: "unavailable", reason: "受付終了" };
  if (event === "before") return { status: "unavailable", reason: "受付前" };

  // 2. プロフィールの対象範囲とアカウントの紐付け
  const profile = data.profiles.find((p) => p.id === account.profileId);
  if (!profile || !account.active) return { status: "ineligible", reason: "アカウント無効" };
  if (account.chainId !== lottery.chainId) return { status: "ineligible", reason: "系列対象外" };
  if (!inProfileScope(profile, lottery.chainId, lottery.storeId)) {
    return { status: "ineligible", reason: "プロフィールの対象外" };
  }

  // 3. スルー（プロフィール別。他プロフィールへは伝播しない。★管理とは独立）
  const skip = skipSourceFor(data, profile.id, lottery);
  if (skip) return { status: "skipped", reason: { lottery: "今回スルー", store: "店舗スルー", chain: "系列スルー" }[skip] };

  // 4. 会員資格・応募条件の確認度
  if (account.membership === "ineligible") return { status: "ineligible", reason: "資格なし" };
  const req = judgeRequirements(data, account, now);
  if (req?.status === "ineligible") return req;
  if (account.membership === "unknown") return { status: "needs_review", reason: "会員資格が未確認" };

  const identity = data.identities.find((i) => i.id === account.identityId);
  const exempt = isExempt(data, lottery.id, account.id);

  // 5. 上限（抽選固有 / キャンペーン / 系列標準の複合）。規約確認済みの手動例外は対象外
  let unconfirmed: EffectiveRule | null = null;
  if (!exempt) {
    const rules = effectiveRules(data, lottery);
    if (rules.length === 0) return { status: "needs_review", reason: "応募制限が未確認" };
    if (!identity) return { status: "needs_review", reason: "名義が未設定" };

    for (const rule of rules) {
      const lotteryIds =
        rule.across === "campaign" && lottery.campaignId
          ? data.lotteries.filter((l) => l.campaignId === lottery.campaignId).map((l) => l.id)
          : [lottery.id];
      const count = activeApplications(data, lotteryIds).filter((a) => {
        if (isExempt(data, a.lotteryId, a.accountId)) return false;
        const other = data.accounts.find((x) => x.id === a.accountId);
        const oi = data.identities.find((i) => i.id === other?.identityId);
        return !!other && !!oi && sameBasis(rule.basis, account, identity, other, oi);
      }).length;
      if (count >= rule.maxCount) return { status: "covered_by_limit", reason: `枠充足（${describeRule(rule)}）` };
      if (rule.confidence === "unconfirmed") unconfirmed ??= rule;
    }
  }
  if (unconfirmed) return { status: "needs_review", reason: `応募制限が未確認（${describeRule(unconfirmed)}）` };
  if (req) return req; // 資格の不明・期限切れ（枠充足なら通知しないので、上限判定の後に返す）

  return { status: "eligible_unapplied", reason: "未応募" };
}

/** 抽選に関係するアカウント(系列一致・有効)を全プロフィール分返す */
export function accountsForLottery(data: AppData, lottery: Lottery): ServiceAccount[] {
  return data.accounts.filter((a) => a.chainId === lottery.chainId && a.active);
}
