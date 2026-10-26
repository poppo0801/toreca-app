"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";
import { settingsFromRow } from "@/lib/server/notification-service";
import { createWebPushSender, isAllowedPushEndpoint } from "@/lib/server/push";
import { notificationSettingsSchema } from "@/lib/notification-settings-input";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "@/lib/notifications";

type Res<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const subscriptionSchema = z.object({
  endpoint: z.string().max(2000).refine(isAllowedPushEndpoint, "対応していないプッシュサービスです"),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(100) }),
});
const profileId = z.uuid();

async function authed(): Promise<{ db: Db; householdId: string } | null> {
  const db = (await createClient()) as unknown as Db;
  const { data } = await db.auth.getUser();
  if (!data.user) return null;
  const householdId = await currentHouseholdId(db);
  return householdId ? { db, householdId } : null;
}

const NEED_LOGIN = { ok: false as const, error: "ログインが必要です" };
const BAD = { ok: false as const, error: "リクエストが不正です" };

/** この端末の購読を、選択中のプロフィールに紐づけて保存する（鍵はRPC経由でのみ保存。クライアントからは読めない）。 */
export async function savePushSubscription(sub: unknown, profile: string, label: string): Promise<Res> {
  const s = subscriptionSchema.safeParse(sub);
  if (!s.success || !profileId.safeParse(profile).success) return BAD;
  const c = await authed();
  if (!c) return NEED_LOGIN;
  const { error } = await c.db.rpc("register_push_subscription", {
    p_endpoint: s.data.endpoint,
    p_p256dh: s.data.keys.p256dh,
    p_auth: s.data.keys.auth,
    p_profile: profile,
    p_label: label.slice(0, 60),
  });
  return error ? { ok: false, error: "通知の登録に失敗しました" } : { ok: true };
}

/** プロフィール切替時に、この端末の通知先を付け替える（旧プロフィールへの紐付けは解除される）。 */
export async function rebindPushSubscription(endpoint: string, profile: string): Promise<Res<{ bound: boolean }>> {
  if (!isAllowedPushEndpoint(endpoint) || !profileId.safeParse(profile).success) return BAD;
  const c = await authed();
  if (!c) return NEED_LOGIN;
  const { data, error } = await c.db.rpc("rebind_push_subscription", { p_endpoint: endpoint, p_profile: profile });
  return error ? { ok: false, error: "通知先の更新に失敗しました" } : { ok: true, bound: data === true };
}

export async function removePushSubscription(endpoint: string): Promise<Res> {
  if (!isAllowedPushEndpoint(endpoint)) return BAD;
  const c = await authed();
  if (!c) return NEED_LOGIN;
  const { error } = await c.db.rpc("remove_push_subscription", { p_endpoint: endpoint });
  return error ? { ok: false, error: "通知の解除に失敗しました" } : { ok: true };
}

export async function getPushSubscriptionStatus(endpoint: string): Promise<Res<{ profileId: string | null; enabled: boolean }>> {
  if (!isAllowedPushEndpoint(endpoint)) return BAD;
  const c = await authed();
  if (!c) return NEED_LOGIN;
  const { data, error } = await c.db.rpc("push_subscription_status", { p_endpoint: endpoint });
  if (error) return { ok: false, error: "状態の取得に失敗しました" };
  const row = (data as { profile_id: string; enabled: boolean }[] | null)?.[0];
  return { ok: true, profileId: row?.profile_id ?? null, enabled: row?.enabled ?? false };
}

export async function loadNotificationSettings(profile: string): Promise<Res<{ settings: NotificationSettings }>> {
  if (!profileId.safeParse(profile).success) return BAD;
  const c = await authed();
  if (!c) return NEED_LOGIN;
  const { data, error } = await c.db.from("notification_settings").select("*").eq("profile_id", profile).maybeSingle();
  if (error) return { ok: false, error: "設定の取得に失敗しました" };
  return { ok: true, settings: data ? settingsFromRow(data) : DEFAULT_NOTIFICATION_SETTINGS };
}

export async function saveNotificationSettings(profile: string, input: unknown, actor: string | null): Promise<Res> {
  const p = notificationSettingsSchema.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "設定内容を確認してください" };
  if (!profileId.safeParse(profile).success || (actor !== null && !profileId.safeParse(actor).success)) return BAD;
  const c = await authed();
  if (!c) return NEED_LOGIN;
  const v = p.data;
  const { error } = await c.db.from("notification_settings").upsert(
    {
      household_id: c.householdId,
      profile_id: profile,
      enabled: v.enabled,
      morning_time: v.morningTime,
      deadline_offsets_min: [...v.deadlineOffsetsMin].sort((a, b) => b - a),
      result_enabled: v.resultEnabled,
      result_reminder_hours: [...v.resultReminderHours].sort((a, b) => a - b),
      procedure_enabled: v.procedureEnabled,
      procedure_lead_hours: [...v.procedureLeadHours].sort((a, b) => b - a),
      date_only_policy: v.dateOnlyPolicy,
      eligibility_expiry_days: v.eligibilityExpiryDays,
      updated_by_profile_id: actor,
    },
    { onConflict: "profile_id" },
  );
  return error ? { ok: false, error: "設定の保存に失敗しました" } : { ok: true };
}

/** この端末へのテスト通知。購読情報は送信にのみ使い、保存しない。 */
export async function sendTestPush(sub: unknown): Promise<Res> {
  const s = subscriptionSchema.safeParse(sub);
  if (!s.success) return BAD;
  const c = await authed();
  if (!c) return NEED_LOGIN;
  try {
    const res = await createWebPushSender()(s.data, {
      title: "テスト通知",
      body: "この端末に通知が届いています。",
      url: "/settings",
      tag: "test",
      type: "test",
    });
    return res.ok ? { ok: true } : { ok: false, error: res.gone ? "この端末の購読が無効です。通知を有効にし直してください" : "送信に失敗しました" };
  } catch {
    return { ok: false, error: "通知サーバーの設定（VAPID）が未完了です" };
  }
}

/** 通知ジョブの稼働状況（件数・個人情報なし）。止まっていないかを画面で確認できる。 */
export async function getNotificationJobStatus(): Promise<
  Res<{ scheduled: boolean; lastRunAt: string | null; lastStatus: string | null; lastSuccessAt: string | null }>
> {
  const c = await authed();
  if (!c) return NEED_LOGIN;
  const { data, error } = await c.db.rpc("notification_job_status");
  if (error) return { ok: false, error: "稼働状況の取得に失敗しました" };
  const row = (data as { last_run_at: string | null; last_status: string | null; last_success_at: string | null; scheduled: boolean }[] | null)?.[0];
  return {
    ok: true,
    scheduled: row?.scheduled ?? false,
    lastRunAt: row?.last_run_at ?? null,
    lastStatus: row?.last_status ?? null,
    lastSuccessAt: row?.last_success_at ?? null,
  };
}
