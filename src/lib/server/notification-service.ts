import { loadAppData, type Db } from "@/lib/server/lottery-service";
import type { PushSender } from "@/lib/server/push";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  planNotifications,
  type NotificationSettings,
  type PlannedNotification,
} from "@/lib/notifications";
import type { Database } from "@/types/database";

type SettingsRow = Database["public"]["Tables"]["notification_settings"]["Row"];

export function settingsFromRow(r: SettingsRow): NotificationSettings {
  return {
    enabled: r.enabled,
    morningTime: r.morning_time.slice(0, 5),
    deadlineOffsetsMin: r.deadline_offsets_min,
    resultEnabled: r.result_enabled,
    resultReminderHours: r.result_reminder_hours,
    procedureEnabled: r.procedure_enabled,
    procedureLeadHours: r.procedure_lead_hours,
    dateOnlyPolicy: r.date_only_policy as "morning_of" | "none",
    eligibilityExpiryDays: r.eligibility_expiry_days,
  };
}

export interface CycleResult {
  households: number;
  planned: number;
  sent: number;
  failed: number;
  suppressed: number;
  /** 送信先の端末が無いため見送った（配信履歴は作らず、窓が有効な間は再評価される） */
  noDevice: number;
  /** 配信済み・他プロセスが処理中などで重複として見送った */
  duplicates: number;
}

const MAX_ATTEMPTS = 3;
/** 送信中のまま止まった行（クラッシュ等）を再試行対象にするまでの時間 */
const STALE_SENDING_MS = 10 * 60_000;

/**
 * 通知ジョブ本体。全世帯について「いま送るべき通知」を再計算し、重複を防ぎながら配信する。
 *  - 配信直前に、現在の状態（応募済み/スルー/対象外/枠充足/★）から再評価した結果だけを送る。
 *  - (profile_id, trigger_key) の一意制約を「先に確保」してから送るため、再実行・並行実行でも二重配信しない。
 *  - 失敗は最大3回まで再試行。購読が失効(404/410)した端末は無効化する。
 * db は service_role のクライアント（世帯ごとに絞って読み込む）。
 */
export async function runNotificationCycle(db: Db, send: PushSender, now: Date = new Date(), onlyHousehold?: string): Promise<CycleResult> {
  const result: CycleResult = { households: 0, planned: 0, sent: 0, failed: 0, suppressed: 0, noDevice: 0, duplicates: 0 };

  const { data: households, error } = await db.from("households").select("id");
  if (error) throw new Error("世帯の取得に失敗しました");

  for (const h of households ?? []) {
    if (onlyHousehold && h.id !== onlyHousehold) continue;
    result.households++;
    const data = await loadAppData(db, h.id);

    const { data: settingsRows } = await db.from("notification_settings").select("*").eq("household_id", h.id);
    const settings: Record<string, NotificationSettings> = {};
    for (const r of settingsRows ?? []) settings[r.profile_id] = settingsFromRow(r);

    const plan = planNotifications(data, settings, now);
    result.planned += plan.due.length;

    // 抑止した段階も記録し、後から再評価されても送られないようにする
    for (const s of plan.suppressed) {
      const { data: inserted } = await db
        .from("notification_deliveries")
        .upsert(
          { household_id: h.id, profile_id: s.profileId, trigger_key: s.triggerKey, type: s.type, lottery_id: s.lotteryId ?? null, status: "suppressed", attempts: 0, error_code: s.reason },
          { onConflict: "profile_id,trigger_key", ignoreDuplicates: true },
        )
        .select("id");
      if (inserted && inserted.length > 0) result.suppressed++;
    }

    const { data: subs } = await db.from("push_subscriptions").select("*").eq("household_id", h.id).eq("enabled", true);
    const subsByProfile = new Map<string, NonNullable<typeof subs>>();
    for (const s of subs ?? []) subsByProfile.set(s.profile_id, [...(subsByProfile.get(s.profile_id) ?? []), s]);

    for (const n of plan.due) {
      const targets = subsByProfile.get(n.profileId) ?? [];
      if (targets.length === 0) {
        result.noDevice++;
        continue;
      }
      const claimed = await claim(db, h.id, n, now);
      if (!claimed) {
        result.duplicates++;
        continue;
      }
      let ok = false;
      let lastStatus: number | null = null;
      for (const t of targets) {
        const res = await send({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, { title: n.title, body: n.body, url: n.url, tag: n.tag, type: n.type });
        if (res.ok) ok = true;
        else {
          lastStatus = res.status;
          if (res.gone) await db.from("push_subscriptions").update({ enabled: false, failure_count: t.failure_count + 1 }).eq("id", t.id);
        }
      }
      await db
        .from("notification_deliveries")
        .update(ok ? { status: "sent", sent_at: new Date().toISOString(), error_code: null } : { status: "failed", error_code: `push_${lastStatus ?? "error"}` })
        .eq("id", claimed);
      if (ok) result.sent++;
      else result.failed++;
    }
  }
  return result;
}

/** 配信権を確保する。取れたら delivery id、他で処理済み/処理中なら null。 */
async function claim(db: Db, householdId: string, n: PlannedNotification, now: Date): Promise<string | null> {
  const { data: inserted } = await db
    .from("notification_deliveries")
    .upsert(
      { household_id: householdId, profile_id: n.profileId, trigger_key: n.triggerKey, type: n.type, lottery_id: n.lotteryId ?? null, status: "sending", attempts: 1 },
      { onConflict: "profile_id,trigger_key", ignoreDuplicates: true },
    )
    .select("id");
  if (inserted && inserted.length > 0) return inserted[0].id;

  // 既存行: 失敗(再試行可)または送信中のまま止まった行だけ、条件付き更新で再確保する
  const { data: existing } = await db
    .from("notification_deliveries")
    .select("id,status,attempts,created_at")
    .eq("profile_id", n.profileId)
    .eq("trigger_key", n.triggerKey)
    .maybeSingle();
  if (!existing || existing.attempts >= MAX_ATTEMPTS) return null;
  const stale = existing.status === "sending" && now.getTime() - new Date(existing.created_at).getTime() > STALE_SENDING_MS;
  if (existing.status !== "failed" && !stale) return null;
  const { data: retaken } = await db
    .from("notification_deliveries")
    .update({ status: "sending", attempts: existing.attempts + 1 })
    .eq("id", existing.id)
    .eq("status", existing.status)
    .eq("attempts", existing.attempts)
    .select("id");
  return retaken && retaken.length > 0 ? retaken[0].id : null;
}

export { DEFAULT_NOTIFICATION_SETTINGS };
