"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import {
  getPushSubscriptionStatus,
  loadNotificationSettings,
  removePushSubscription,
  saveNotificationSettings,
  savePushSubscription,
  sendTestPush,
} from "@/app/(app)/settings/notifications/actions";
import { DEADLINE_OFFSET_OPTIONS, PROCEDURE_LEAD_OPTIONS, RESULT_REMINDER_OPTIONS } from "@/lib/notification-settings-input";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings as Settings } from "@/lib/notifications";
import { currentSubscription, isIos, isStandalone, pushSupported, subscribeToPush, subscriptionJson } from "@/lib/push-client";

const offsetLabel = (m: number) => (m >= 60 ? `${m / 60}時間前` : `${m}分前`);

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/**
 * 通知設定。端末ごとの購読（この端末が誰の通知を受け取るか）と、プロフィール別の通知ルール。
 * 通知が使えない環境でも、抽選管理ページの「要対応」アラートで同じ内容を確認できる。
 */
export function NotificationSettings() {
  const { profile, data } = useApp();
  const [supported] = useState(() => pushSupported());
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    pushSupported() ? Notification.permission : "unsupported",
  );
  const [subscribed, setSubscribed] = useState(false);
  const [boundProfileId, setBoundProfileId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_NOTIFICATION_SETTINGS);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshDevice = useCallback(async () => {
    const sub = await currentSubscription();
    setSubscribed(!!sub);
    if (sub) {
      const st = await getPushSubscriptionStatus(sub.endpoint);
      setBoundProfileId(st.ok ? st.profileId : null);
    } else setBoundProfileId(null);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 端末の購読状態の取得
    void refreshDevice();
  }, [refreshDevice, profile.id]);

  useEffect(() => {
    let alive = true;
    loadNotificationSettings(profile.id).then((r) => {
      if (alive && r.ok) setSettings(r.settings);
    });
    return () => {
      alive = false;
    };
  }, [profile.id]);

  const enable = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const sub = await subscribeToPush();
      const res = await savePushSubscription(subscriptionJson(sub), profile.id, navigator.userAgent.includes("iPhone") ? "iPhone" : "この端末");
      setMessage(res.ok ? `この端末を「${profile.label}」の通知先に登録しました` : res.error);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "通知を有効にできませんでした");
    }
    setPermission(Notification.permission);
    await refreshDevice();
    setBusy(false);
  };

  const disable = async () => {
    setBusy(true);
    const sub = await currentSubscription();
    if (sub) {
      await removePushSubscription(sub.endpoint);
      await sub.unsubscribe().catch(() => undefined);
    }
    setMessage("この端末の通知を停止しました");
    await refreshDevice();
    setBusy(false);
  };

  const test = async () => {
    setBusy(true);
    const sub = await currentSubscription();
    const res = sub ? await sendTestPush(subscriptionJson(sub)) : ({ ok: false, error: "この端末は通知が有効ではありません" } as const);
    setMessage(res.ok ? "テスト通知を送信しました" : res.error);
    setBusy(false);
  };

  const save = async () => {
    setBusy(true);
    const res = await saveNotificationSettings(profile.id, settings, profile.id);
    setMessage(res.ok ? `「${profile.label}」の通知設定を保存しました` : res.error);
    setBusy(false);
  };

  const bound = data.profiles.find((p) => p.id === boundProfileId);
  const needsInstall = isIos() && !isStandalone();

  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1">
        <p className="font-medium">この端末</p>
        {needsInstall && (
          <p className="rounded-md border border-warn p-2 text-xs">
            iPhoneでは、Safariの共有ボタンから「ホーム画面に追加」したアプリを開いたときだけ通知を受け取れます（iOS 16.4以降）。ホーム画面のアイコンから開き直してください。
          </p>
        )}
        {!supported && <p className="text-xs text-muted-foreground">このブラウザはプッシュ通知に対応していません。抽選管理ページの「要対応」アラートで確認できます。</p>}
        {supported && permission === "denied" && (
          <p className="text-xs text-danger">通知がブロックされています。端末・ブラウザの設定で通知を許可してください。</p>
        )}
        <p className="text-xs text-muted-foreground">
          状態: {subscribed ? (bound ? `有効（通知先: プロフィール${bound.label}）` : "購読あり（プロフィール未登録）") : "未設定"}
          {subscribed && bound && bound.id !== profile.id && "（プロフィールを切り替えると通知先も自動で切り替わります）"}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {!subscribed || !bound ? (
            <Button size="sm" onClick={enable} disabled={busy || !supported || needsInstall}>
              「{profile.label}」としてこの端末の通知を有効にする
            </Button>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={test} disabled={busy}>
                テスト通知を送る
              </Button>
              <Button size="sm" variant="outline" onClick={disable} disabled={busy}>
                この端末の通知を停止
              </Button>
            </>
          )}
        </div>
      </div>

      <fieldset className="space-y-3 rounded-md border p-3">
        <legend className="px-1 font-medium">プロフィール「{profile.label}」の通知ルール</legend>
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" className="size-4" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} />
          通知を受け取る
        </label>
        <label className="flex flex-wrap items-center gap-2">
          締切当日の朝の通知時刻
          <input
            type="time"
            value={settings.morningTime}
            onChange={(e) => setSettings({ ...settings, morningTime: e.target.value })}
            className="min-h-10 rounded-md border bg-background px-2"
          />
        </label>
        <div>
          <p className="mb-1">応募締切の何前に通知する（時刻が分かっている締切のみ）</p>
          <div className="flex flex-wrap gap-2">
            {DEADLINE_OFFSET_OPTIONS.map((o) => (
              <label key={o} className="flex min-h-9 items-center gap-1 rounded border px-2">
                <input type="checkbox" className="size-4" checked={settings.deadlineOffsetsMin.includes(o)} onChange={() => setSettings({ ...settings, deadlineOffsetsMin: toggle(settings.deadlineOffsetsMin, o) })} />
                {offsetLabel(o)}
              </label>
            ))}
          </div>
        </div>
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" className="size-4" checked={settings.resultEnabled} onChange={(e) => setSettings({ ...settings, resultEnabled: e.target.checked })} />
          当落発表と、結果が未確認のときの再通知
        </label>
        {settings.resultEnabled && (
          <div className="flex flex-wrap gap-2 pl-6">
            {RESULT_REMINDER_OPTIONS.map((h) => (
              <label key={h} className="flex min-h-9 items-center gap-1 rounded border px-2">
                <input type="checkbox" className="size-4" checked={settings.resultReminderHours.includes(h)} onChange={() => setSettings({ ...settings, resultReminderHours: toggle(settings.resultReminderHours, h) })} />
                発表の{h}時間後
              </label>
            ))}
          </div>
        )}
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" className="size-4" checked={settings.procedureEnabled} onChange={(e) => setSettings({ ...settings, procedureEnabled: e.target.checked })} />
          購入手続き・受取期限の通知
        </label>
        {settings.procedureEnabled && (
          <div className="flex flex-wrap gap-2 pl-6">
            {PROCEDURE_LEAD_OPTIONS.map((h) => (
              <label key={h} className="flex min-h-9 items-center gap-1 rounded border px-2">
                <input type="checkbox" className="size-4" checked={settings.procedureLeadHours.includes(h)} onChange={() => setSettings({ ...settings, procedureLeadHours: toggle(settings.procedureLeadHours, h) })} />
                期限の{h}時間前
              </label>
            ))}
          </div>
        )}
        <label className="block">
          時刻が不明（日付のみ）の期限
          <select
            value={settings.dateOnlyPolicy}
            onChange={(e) => setSettings({ ...settings, dateOnlyPolicy: e.target.value as Settings["dateOnlyPolicy"] })}
            className="mt-1 min-h-10 w-full rounded-md border bg-background px-2"
          >
            <option value="morning_of">当日の朝に「時刻未確認」として通知する</option>
            <option value="none">通知しない（画面で確認する）</option>
          </select>
        </label>
        <label className="block">
          応募資格の有効期限の通知
          <select
            value={settings.eligibilityExpiryDays}
            onChange={(e) => setSettings({ ...settings, eligibilityExpiryDays: Number(e.target.value) })}
            className="mt-1 min-h-10 w-full rounded-md border bg-background px-2"
          >
            <option value={0}>通知しない</option>
            <option value={7}>7日前</option>
            <option value={14}>14日前</option>
            <option value={30}>30日前</option>
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          応募済み・スルー・対象外・枠充足・要確認の抽選は通知されません。期限が日付のみ／不明の場合は時刻を仮定しません。
        </p>
        <Button size="sm" onClick={save} disabled={busy}>
          通知ルールを保存
        </Button>
      </fieldset>
      {message && (
        <p role="status" className="text-xs">
          {message}
        </p>
      )}
    </div>
  );
}
