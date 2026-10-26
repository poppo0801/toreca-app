import type {
  AppData,
  Application,
  AuditEntry,
  EventState,
  FulfillmentStatus,
  Purchase,
  ResultStatus,
  SkipRule,
} from "@/types/domain";

/**
 * 状態変更の純関数群。モックRepositoryとテストで共用し、Supabase版では同じ規則をサーバー側で実装する。
 * すべての変更は操作履歴(audit)に「実行プロフィール・日時・変更前後」を残す。
 */

let seq = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function withAudit(
  data: AppData,
  entry: Omit<AuditEntry, "id">,
): AppData["audit"] {
  return [{ id: newId("audit"), ...entry }, ...data.audit];
}

/** ★切替。OFFにしても応募・当落・購入履歴は消さない。 */
export function setManaged(
  data: AppData,
  actorProfileId: string,
  lotteryId: string,
  isManaged: boolean,
  at: Date,
): AppData {
  const before = data.management.find((m) => m.lotteryId === lotteryId);
  if ((before?.isManaged ?? false) === isManaged) return data; // 冪等
  const next = before
    ? data.management.map((m) =>
        m.lotteryId === lotteryId
          ? { ...m, isManaged, managedSource: "manual" as const, managedAt: at.toISOString() }
          : m,
      )
    : [
        ...data.management,
        { lotteryId, isManaged, managedSource: "manual" as const, managedAt: at.toISOString() },
      ];
  return {
    ...data,
    management: next,
    // ★ON時はNEW表示を確認済みにする
    lotteries: isManaged
      ? data.lotteries.map((l) => (l.id === lotteryId ? { ...l, isNew: false } : l))
      : data.lotteries,
    audit: withAudit(data, {
      actorProfileId,
      at: at.toISOString(),
      entityType: "lottery_management",
      entityId: lotteryId,
      action: isManaged ? "managed_on" : "managed_off",
      before: { isManaged: before?.isManaged ?? false },
      after: { isManaged },
    }),
  };
}

/** 応募の記録／取消。抽選×アカウントで一意。取消しても行は残し state を変える。 */
export function setApplied(
  data: AppData,
  actorProfileId: string,
  lotteryId: string,
  accountId: string,
  applied: boolean,
  at: Date,
): AppData {
  const existing = data.applications.find(
    (a) => a.lotteryId === lotteryId && a.accountId === accountId,
  );
  const state: Application["state"] = applied ? "applied" : "cancelled";
  if (existing?.state === state) return data;
  if (!existing && !applied) return data;
  const nowIso = at.toISOString();
  const applications = existing
    ? data.applications.map((a) => (a.id === existing.id ? { ...a, state } : a))
    : [
        ...data.applications,
        {
          id: newId("app"),
          lotteryId,
          accountId,
          appliedAt: nowIso,
          state,
          result: "pending" as const,
          resultConfirmedAt: null,
          fulfillment: "none" as const,
          createdAt: nowIso,
        },
      ];
  return {
    ...data,
    applications,
    audit: withAudit(data, {
      actorProfileId,
      at: nowIso,
      entityType: "application",
      entityId: `${lotteryId}:${accountId}`,
      action: applied ? "apply" : "cancel_apply",
      before: { state: existing?.state ?? null },
      after: { state },
    }),
  };
}

export function setResult(
  data: AppData,
  actorProfileId: string,
  applicationId: string,
  result: ResultStatus,
  at: Date,
): AppData {
  const app = data.applications.find((a) => a.id === applicationId);
  if (!app || app.result === result) return data;
  return {
    ...data,
    applications: data.applications.map((a) =>
      a.id === applicationId
        ? { ...a, result, resultConfirmedAt: result === "pending" ? null : at.toISOString() }
        : a,
    ),
    audit: withAudit(data, {
      actorProfileId,
      at: at.toISOString(),
      entityType: "application_result",
      entityId: applicationId,
      action: "set_result",
      before: { result: app.result },
      after: { result },
    }),
  };
}

/**
 * 購入手続き／購入済みの更新。購入済みは purchases を applicationId で一意に作成し、
 * 何度押しても明細が二重生成されない。
 */
export function setFulfillment(
  data: AppData,
  actorProfileId: string,
  applicationId: string,
  fulfillment: FulfillmentStatus,
  at: Date,
): AppData {
  const app = data.applications.find((a) => a.id === applicationId);
  if (!app || app.result !== "won" || app.fulfillment === fulfillment) return data;
  const hasPurchase = data.purchases.some((p) => p.applicationId === applicationId);
  return {
    ...data,
    applications: data.applications.map((a) => (a.id === applicationId ? { ...a, fulfillment } : a)),
    purchases:
      fulfillment === "purchased" && !hasPurchase
        ? [...data.purchases, purchaseFromLottery(data, app, at)]
        : data.purchases,
    audit: withAudit(data, {
      actorProfileId,
      at: at.toISOString(),
      entityType: "award_fulfillment",
      entityId: applicationId,
      action: "set_fulfillment",
      before: { fulfillment: app.fulfillment },
      after: { fulfillment },
    }),
  };
}

/** 「今回だけ」スルー。実行プロフィールにのみ作用し、他プロフィールへ伝播しない。 */
export function setLotterySkip(
  data: AppData,
  profileId: string,
  lotteryId: string,
  skip: boolean,
  at: Date,
): AppData {
  const existing = data.skipRules.find(
    (r) => r.profileId === profileId && r.scope === "lottery" && r.scopeId === lotteryId,
  );
  if (skip === !!existing) return data;
  const skipRules: SkipRule[] = skip
    ? [
        ...data.skipRules,
        { id: newId("skip"), profileId, scope: "lottery", scopeId: lotteryId, exceptionLotteryIds: [] },
      ]
    : data.skipRules.filter((r) => r.id !== existing?.id);
  return {
    ...data,
    skipRules,
    audit: withAudit(data, {
      actorProfileId: profileId,
      at: at.toISOString(),
      entityType: "skip_rule",
      entityId: lotteryId,
      action: skip ? "skip_on" : "skip_off",
      before: { skipped: !skip },
      after: { skipped: skip },
    }),
  };
}

/** 当選した抽選の商品明細から購入記録を作る（金額は不明=null） */
function purchaseFromLottery(data: AppData, app: Application, at: Date): Purchase {
  const lottery = data.lotteries.find((l) => l.id === app.lotteryId);
  return {
    id: newId("pur"),
    applicationId: app.id,
    storeId: lottery?.storeId ?? null,
    purchasedOn: { precision: "date_time", at: at.toISOString() },
    channel: lottery?.receiveMethod === "shipping" ? "shipping" : "store",
    source: "lottery",
    items: (lottery?.items ?? []).map((i) => ({ productId: i.productId, quantity: i.quantity, unit: i.unit, amountPaid: null })),
    note: "",
  };
}

/** 抽選全体の状態（中止・発表延期など）。個別の当落とは別。 */
export function setEventState(
  data: AppData,
  actorProfileId: string,
  lotteryId: string,
  state: EventState,
  at: Date,
): AppData {
  const lot = data.lotteries.find((l) => l.id === lotteryId);
  if (!lot || lot.eventState === state) return data;
  return {
    ...data,
    lotteries: data.lotteries.map((l) => (l.id === lotteryId ? { ...l, eventState: state } : l)),
    audit: withAudit(data, {
      actorProfileId,
      at: at.toISOString(),
      entityType: "lottery",
      entityId: lotteryId,
      action: "set_event_state",
      before: { eventState: lot.eventState },
      after: { eventState: state },
    }),
  };
}
