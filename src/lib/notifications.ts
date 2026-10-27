import { formatFlexible, isPast, jstDateString } from "@/lib/datetime";
import { effectiveEventState, judgeAccount } from "@/lib/eligibility";
import { formatItem, isManaged } from "@/lib/lottery-view";
import type { AppData, FlexibleDate, Lottery, Profile } from "@/types/domain";

/**
 * 通知の計画（純関数）。「いま送るべき通知」を現在の状態から毎回再計算する。
 *  - 応募済み・スルー・対象外・枠充足・要確認は通知しない（judgeAccount と同じ判定を共用）。
 *  - 日付のみ・不明の期限は時刻を仮定しない。日付のみは設定により「当日の朝に時刻未確認として通知」か「通知しない」。
 *  - 配信の冪等キー(triggerKey)で二重送信を防ぐ（DB側の unique(profile_id, trigger_key) と併用）。
 *  - 過去分の一斉送信を防ぐ: 期限型は期限前のみ、結果型は登録後に迎えた時点のみ、窓(expiresAt)を過ぎたものは送らない。
 */

export interface NotificationSettings {
  enabled: boolean;
  /** JST の "HH:mm" */
  morningTime: string;
  deadlineOffsetsMin: number[];
  resultEnabled: boolean;
  resultReminderHours: number[];
  procedureEnabled: boolean;
  procedureLeadHours: number[];
  dateOnlyPolicy: "morning_of" | "none";
  eligibilityExpiryDays: number;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  morningTime: "09:00",
  deadlineOffsetsMin: [120, 15],
  resultEnabled: true,
  resultReminderHours: [3, 24],
  procedureEnabled: true,
  procedureLeadHours: [24, 3],
  dateOnlyPolicy: "morning_of",
  eligibilityExpiryDays: 14,
};

export type NotificationType =
  | "deadline_morning"
  | "deadline_before"
  | "result_day"
  | "result_unconfirmed"
  | "procedure_before"
  | "eligibility_expiry";

export interface PlannedNotification {
  profileId: string;
  type: NotificationType;
  /** 同じ(profile, triggerKey)は1回だけ送る */
  triggerKey: string;
  dueAt: Date;
  /** これを過ぎたら送らない（古い通知の一斉送信防止） */
  expiresAt: Date;
  lotteryId?: string;
  title: string;
  body: string;
  url: string;
  /** OSの通知センターで同じ対象の通知をまとめるためのタグ */
  tag: string;
}

export interface SuppressedNotification {
  profileId: string;
  type: NotificationType;
  triggerKey: string;
  lotteryId?: string;
  reason: "superseded" | "registered_after_due";
}

export interface NotificationPlan {
  due: PlannedNotification[];
  suppressed: SuppressedNotification[];
}

/** 通知の送り先。未設定(null/undefined)は本人のみ、空配列は通知なし。 */
export function recipientsOf(p: Pick<Profile, "id" | "notifyRecipientIds">): string[] {
  return p.notifyRecipientIds == null ? [p.id] : p.notifyRecipientIds;
}

/** recipientId 宛ての通知対象となる応募ユーザー（本人＋通知先に指定してくれているユーザー）。有効なプロフィールのみ。 */
export function applicantsFor(data: AppData, recipientId: string): Profile[] {
  return data.profiles.filter((p) => p.active !== false && recipientsOf(p).includes(recipientId));
}

const HOUR = 3600_000;
const MIN = 60_000;
/** 結果型など「時刻に紐づく通知」を、本来の時刻からどれだけ遅れて送ってよいか */
const STALE_WINDOW_MS = 6 * HOUR;

/** JST の日付 + "HH:mm" → Date */
export function jstAt(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+09:00`);
}

export function addDaysJst(date: string, days: number): string {
  return jstDateString(new Date(jstAt(date, "12:00").getTime() + days * 86400_000));
}

const endOfJstDay = (date: string) => jstAt(addDaysJst(date, 1), "00:00");


function flexKey(v: FlexibleDate): string {
  return v.precision === "date_only" ? v.date : v.precision === "date_time" ? v.at : "none";
}

function lotteryLabel(data: AppData, l: Lottery): string {
  const chain = data.chains.find((c) => c.id === l.chainId)?.name ?? "";
  const store = data.stores.find((s) => s.id === l.storeId)?.name ?? "";
  const first = l.items[0];
  const product = first ? formatItem(first, data.products.find((p) => p.id === first.productId)) : "";
  const more = l.items.length > 1 ? ` ほか${l.items.length - 1}件` : "";
  return `${chain} ${store} ${product}${more}`.trim();
}

function remainingText(deadline: Date, now: Date): string {
  const min = Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / MIN));
  if (min < 60) return `あと${min}分`;
  if (min < 1440) return `あと${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ""}`;
  return `あと${Math.floor(min / 1440)}日`;
}

interface Candidate extends PlannedNotification {
  /** 同じ対象で段階的に増える通知のグループ。due のうち最も締切に近い1件だけ送る */
  group?: string;
  /** 時刻の後に登録された場合は送らない（過去分の通知抑止）。undefined=登録時刻を問わない */
  baseline?: Date;
}

/**
 * 計画の生成。now 時点で「窓の中にある(dueAt <= now < expiresAt)」通知のみ due に入る。
 * 段階的な通知（朝/2時間前/15分前 など）は、遅れて登録された場合に古い段階を連続送信しないよう、
 * 最も締切に近い1件だけを送り、残りは suppressed として記録する。
 */
export function planNotifications(
  data: AppData,
  settingsByProfile: Record<string, NotificationSettings | undefined>,
  now: Date,
): NotificationPlan {
  const candidates: Candidate[] = [];

  for (const profile of data.profiles) {
    if (profile.active === false) continue;
    const s = settingsByProfile[profile.id] ?? DEFAULT_NOTIFICATION_SETTINGS;
    if (!s.enabled) continue;
    // 応募名義と通知先は別。この受信者宛てに集約する応募ユーザー（本人＋通知先に指定したユーザー）の分を1通にまとめる
    const applicantIds = new Set(applicantsFor(data, profile.id).map((p) => p.id));
    if (applicantIds.size === 0) continue;
    const accounts = data.accounts.filter((a) => applicantIds.has(a.profileId) && a.active);
    const ownerName = (accountId: string) => {
      const acc = accounts.find((x) => x.id === accountId);
      return data.profiles.find((p) => p.id === acc?.profileId)?.label ?? acc?.label;
    };

    for (const l of data.lotteries) {
      const label = lotteryLabel(data, l);
      const myAccounts = accounts.filter((a) => a.chainId === l.chainId);
      if (myAccounts.length === 0) continue;
      const url = "/lotteries";
      const base = { profileId: profile.id, lotteryId: l.id, url, tag: `lottery:${l.id}` };

      // ---- 応募締切（★管理対象で、このプロフィールに未応募のアカウントがあるときだけ）
      if (isManaged(data, l.id) && effectiveEventState(l, now) === "open") {
        const missing = myAccounts.filter((a) => judgeAccount(data, l, a, now).status === "eligible_unapplied");
        if (missing.length > 0) {
          const who = [...new Set(missing.map((a) => ownerName(a.id)))].join("、");
          const dl = l.applyDeadline;
          const dlKey = flexKey(dl);
          if (dl.precision === "date_time") {
            const at = new Date(dl.at);
            const dlLabel = formatFlexible(dl);
            const morning = jstAt(jstDateString(at), s.morningTime);
            if (morning < at) {
              candidates.push({
                ...base,
                type: "deadline_morning",
                triggerKey: `deadline_morning:${l.id}:${dlKey}`,
                dueAt: morning,
                expiresAt: at,
                group: `deadline:${l.id}`,
                title: "本日が応募締切です",
                body: `${label}\n未応募: ${who} ／ 締切 ${dlLabel}`,
              });
            }
            for (const off of s.deadlineOffsetsMin) {
              candidates.push({
                ...base,
                type: "deadline_before",
                triggerKey: `deadline_before:m${off}:${l.id}:${dlKey}`,
                dueAt: new Date(at.getTime() - off * MIN),
                expiresAt: at,
                group: `deadline:${l.id}`,
                title: "応募締切が迫っています",
                // 本文の残り時間は送信時点の実際の値（遅れて送る場合も「あと2時間」と偽らない）
                body: `${label}\n未応募: ${who} ／ 締切 ${dlLabel}（${remainingText(at, now)}）`,
              });
            }
          } else if (dl.precision === "date_only" && s.dateOnlyPolicy === "morning_of") {
            candidates.push({
              ...base,
              type: "deadline_morning",
              triggerKey: `deadline_morning:${l.id}:${dlKey}`,
              dueAt: jstAt(dl.date, s.morningTime),
              expiresAt: endOfJstDay(dl.date),
              title: "本日が応募締切です（時刻未確認）",
              body: `${label}\n未応募: ${who} ／ 締切の時刻は未確認です。早めに確認してください`,
            });
          }
        }
      }

      // ---- 当落発表・結果未確認の再通知
      const pending = data.applications.filter(
        (a) => a.lotteryId === l.id && a.state === "applied" && a.result === "pending" && myAccounts.some((x) => x.id === a.accountId),
      );
      if (s.resultEnabled && pending.length > 0 && l.eventState !== "cancelled") {
        const baseline = new Date(Math.max(...pending.map((a) => new Date(a.createdAt).getTime())));
        const rd = l.resultDate;
        const rKey = flexKey(rd);
        const who = [...new Set(pending.map((a) => ownerName(a.accountId)).filter(Boolean))].join("、");
        const mk = (type: NotificationType, tier: string, dueAt: Date, title: string, body: string, group?: string): Candidate => ({
          ...base,
          type,
          triggerKey: `${type}:${tier}:${l.id}:${rKey}`,
          dueAt,
          expiresAt: new Date(dueAt.getTime() + STALE_WINDOW_MS),
          title,
          body: `${label}\n応募: ${who}\n${body}`,
          group,
          baseline,
        });
        if (rd.precision === "date_time") {
          const at = new Date(rd.at);
          candidates.push(mk("result_day", "at", at, "当落が発表されました", "結果を確認して登録してください"));
          for (const h of s.resultReminderHours) {
            candidates.push(
              mk("result_unconfirmed", `h${h}`, new Date(at.getTime() + h * HOUR), "当落の結果が未確認です", "結果を確認して登録してください", `result:${l.id}`),
            );
          }
        } else if (rd.precision === "date_only" && s.dateOnlyPolicy === "morning_of") {
          candidates.push(mk("result_day", "morning", jstAt(rd.date, s.morningTime), "本日が当落発表日です（時刻未確認）", "発表後に結果を登録してください"));
          candidates.push(
            mk("result_unconfirmed", "next-morning", jstAt(addDaysJst(rd.date, 1), s.morningTime), "当落の結果が未確認です", "発表日を過ぎています。結果を確認して登録してください", `result:${l.id}`),
          );
        }
      }

      // ---- 購入手続き・受取期限（当選済みで未購入）
      const won = data.applications.filter(
        (a) =>
          a.lotteryId === l.id && a.state === "applied" && a.result === "won" && a.fulfillment !== "purchased" &&
          myAccounts.some((x) => x.id === a.accountId),
      );
      if (s.procedureEnabled && won.length > 0) {
        const pd = l.procedureDeadline;
        const pKey = flexKey(pd);
        const who = [...new Set(won.map((a) => ownerName(a.accountId)).filter(Boolean))].join("、");
        const mk = (tier: string, dueAt: Date, expiresAt: Date, body: string): Candidate => ({
          ...base,
          type: "procedure_before",
          triggerKey: `procedure_before:${tier}:${l.id}:${pKey}`,
          dueAt,
          expiresAt,
          group: `procedure:${l.id}`,
          title: "購入手続き・受取の期限が近づいています",
          body: `${label}\n当選: ${who}\n${body}`,
        });
        if (pd.precision === "date_time") {
          const at = new Date(pd.at);
          for (const h of s.procedureLeadHours) {
            candidates.push(mk(`h${h}`, new Date(at.getTime() - h * HOUR), at, `期限 ${formatFlexible(pd)}（${remainingText(at, now)}）`));
          }
        } else if (pd.precision === "date_only" && s.dateOnlyPolicy === "morning_of") {
          const days = new Set([0, ...s.procedureLeadHours.map((h) => Math.max(1, Math.ceil(h / 24)))]);
          for (const k of days) {
            candidates.push(mk(`d${k}`, jstAt(addDaysJst(pd.date, -k), s.morningTime), endOfJstDay(pd.date), `期限 ${formatFlexible(pd)}`));
          }
        }
      }
    }

    // ---- 資格の有効期限（失効前の通知）
    if (s.eligibilityExpiryDays > 0) {
      for (const e of data.eligibilities) {
        const acc = accounts.find((a) => a.id === e.accountId);
        if (!acc || e.state !== "eligible" || !e.validUntil) continue;
        const req = data.requirements.find((r) => r.id === e.requirementId);
        const chain = data.chains.find((c) => c.id === acc.chainId)?.name ?? "";
        candidates.push({
          profileId: profile.id,
          type: "eligibility_expiry",
          triggerKey: `eligibility_expiry:${e.id}:${e.validUntil}`,
          dueAt: jstAt(addDaysJst(e.validUntil, -s.eligibilityExpiryDays), s.morningTime),
          expiresAt: endOfJstDay(e.validUntil),
          url: "/settings/masters",
          tag: `eligibility:${e.id}`,
          title: "応募資格の有効期限が近づいています",
          body: `${chain} ${req?.label ?? ""}（${ownerName(acc.id) ?? acc.label}）\n有効期限 ${e.validUntil.slice(5).replace("-", "/")}`,
        });
      }
    }
  }

  // ---- 窓の判定・段階の間引き
  const due: PlannedNotification[] = [];
  const suppressed: SuppressedNotification[] = [];
  const inWindow = candidates.filter((c) => c.dueAt <= now && now < c.expiresAt);

  const groups = new Map<string, Candidate[]>();
  const singles: Candidate[] = [];
  for (const c of inWindow) {
    if (c.group) {
      const k = `${c.profileId}|${c.group}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    } else singles.push(c);
  }
  const keep: Candidate[] = [...singles];
  for (const list of groups.values()) {
    list.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
    keep.push(list[list.length - 1]);
    for (const old of list.slice(0, -1)) {
      suppressed.push({ profileId: old.profileId, type: old.type, triggerKey: old.triggerKey, lotteryId: old.lotteryId, reason: "superseded" });
    }
  }
  for (const c of keep) {
    if (c.baseline && c.dueAt < c.baseline) {
      suppressed.push({ profileId: c.profileId, type: c.type, triggerKey: c.triggerKey, lotteryId: c.lotteryId, reason: "registered_after_due" });
      continue;
    }
    const { group, baseline, ...n } = c;
    void group;
    void baseline;
    due.push(n);
  }
  due.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.triggerKey.localeCompare(b.triggerKey));
  return { due, suppressed };
}

// ------------------------------------------------------------------ 画面内アラート（通知が使えない環境の代替）
export interface InAppAlert {
  /** 既読管理用の安定キー（種別 + 抽選 + 期限）。期限が変わると新しい通知として扱う */
  key: string;
  kind: "apply_soon" | "result_overdue" | "procedure_soon" | "eligibility_expiring";
  lotteryId?: string;
  title: string;
  detail: string;
  urgent: boolean;
}

/** 現在のプロフィールが対応すべき項目。プッシュ通知の有無に関わらず画面で確認できる。 */
export function computeAlerts(data: AppData, profileId: string, now: Date): InAppAlert[] {
  const alerts: InAppAlert[] = [];
  const applicantIds = new Set(applicantsFor(data, profileId).map((p) => p.id));
  const mine = data.accounts.filter((a) => applicantIds.has(a.profileId) && a.active);
  const owner = (accountId: string) => data.profiles.find((p) => p.id === mine.find((a) => a.id === accountId)?.profileId)?.label ?? "";
  const day = jstDateString(now);

  for (const l of data.lotteries) {
    const accs = mine.filter((a) => a.chainId === l.chainId);
    if (accs.length === 0) continue;
    const label = lotteryLabel(data, l);

    if (isManaged(data, l.id) && effectiveEventState(l, now) === "open") {
      const missing = accs.filter((a) => judgeAccount(data, l, a, now).status === "eligible_unapplied");
      const dl = l.applyDeadline;
      if (missing.length > 0) {
        const remainMs = dl.precision === "date_time" ? new Date(dl.at).getTime() - now.getTime() : null;
        if (dl.precision === "date_time" && remainMs !== null && remainMs <= 24 * HOUR) {
          alerts.push({ key: `apply:${l.id}:${flexKey(dl)}`, kind: "apply_soon", lotteryId: l.id, title: `未応募: ${label}`, detail: `${[...new Set(missing.map((a) => owner(a.id)))].join("、")} ／ 締切 ${formatFlexible(dl)}（${remainingText(new Date(dl.at), now)}）`, urgent: remainMs <= 3 * HOUR });
        } else if (dl.precision === "date_only" && dl.date === day) {
          alerts.push({ key: `apply:${l.id}:${flexKey(dl)}`, kind: "apply_soon", lotteryId: l.id, title: `本日締切: ${label}`, detail: `${[...new Set(missing.map((a) => owner(a.id)))].join("、")} ／ 締切 ${formatFlexible(dl)}`, urgent: true });
        }
      }
    }

    const pending = data.applications.some(
      (a) => a.lotteryId === l.id && a.state === "applied" && a.result === "pending" && accs.some((x) => x.id === a.accountId),
    );
    if (pending && isPast(l.resultDate, now) === true && l.eventState !== "cancelled") {
      alerts.push({ key: `result:${l.id}:${flexKey(l.resultDate)}`, kind: "result_overdue", lotteryId: l.id, title: `結果が未登録: ${label}`, detail: `発表 ${formatFlexible(l.resultDate)} を過ぎています`, urgent: true });
    }

    const won = data.applications.some(
      (a) => a.lotteryId === l.id && a.state === "applied" && a.result === "won" && a.fulfillment !== "purchased" && accs.some((x) => x.id === a.accountId),
    );
    if (won) {
      const pd = l.procedureDeadline;
      const soon =
        pd.precision === "date_time"
          ? new Date(pd.at).getTime() - now.getTime() <= 72 * HOUR && new Date(pd.at) > now
          : pd.precision === "date_only"
            ? pd.date >= day && pd.date <= addDaysJst(day, 3)
            : false;
      if (soon) alerts.push({ key: `procedure:${l.id}:${flexKey(pd)}`, kind: "procedure_soon", lotteryId: l.id, title: `購入・受取の期限: ${label}`, detail: `期限 ${formatFlexible(pd)}`, urgent: true });
    }
  }

  for (const e of data.eligibilities) {
    const acc = mine.find((a) => a.id === e.accountId);
    if (!acc || e.state !== "eligible" || !e.validUntil) continue;
    if (e.validUntil >= day && e.validUntil <= addDaysJst(day, 14)) {
      const req = data.requirements.find((r) => r.id === e.requirementId);
      alerts.push({ key: `elig:${e.id}:${e.validUntil}`, kind: "eligibility_expiring", title: `資格の有効期限が近い: ${req?.label ?? ""}（${acc.label}）`, detail: `有効期限 ${e.validUntil}`, urgent: false });
    }
  }
  return alerts.sort((a, b) => Number(b.urgent) - Number(a.urgent));
}

/**
 * タブの赤丸と未対応件数。件数は「抽選」単位で数え、1応募に複数商品があっても重複計上しない。
 *  - appliedDot: 発表日を過ぎても結果が未登録の応募がある（「応募済み」タブ）
 *  - wonDot: 当選済みで購入・受取が完了していない応募がある（「当選」タブ）
 */
export function tabDots(data: AppData, profileId: string, now: Date): { appliedDot: boolean; wonDot: boolean } {
  const applicantIds = new Set(applicantsFor(data, profileId).map((p) => p.id));
  const mine = new Set(data.accounts.filter((a) => applicantIds.has(a.profileId) && a.active).map((a) => a.id));
  let appliedDot = false;
  let wonDot = false;
  for (const l of data.lotteries) {
    if (l.eventState === "cancelled") continue;
    const apps = data.applications.filter((a) => a.lotteryId === l.id && a.state === "applied" && mine.has(a.accountId));
    if (!appliedDot && isPast(l.resultDate, now) === true && apps.some((a) => a.result === "pending")) appliedDot = true;
    if (!wonDot && apps.some((a) => a.result === "won" && a.fulfillment !== "purchased")) wonDot = true;
  }
  return { appliedDot, wonDot };
}
