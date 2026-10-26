"use client";

import { AlertTriangle } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { computeAlerts } from "@/lib/notifications";
import { cn } from "@/lib/utils";

/**
 * 要対応の一覧（締切間近の未応募・結果未登録・購入期限・資格期限）。
 * プッシュ通知が使えない/見逃した場合でも、画面で同じ内容を確認できる。
 */
export function AlertsBar() {
  const { data, profile, now } = useApp();
  const alerts = computeAlerts(data, profile.id, now);
  if (alerts.length === 0) return null;
  const urgent = alerts.filter((a) => a.urgent).length;
  return (
    <details open={urgent > 0} className="rounded-lg border border-primary p-2 text-sm" data-testid="alerts-bar">
      <summary className="flex min-h-9 cursor-pointer items-center gap-2 font-medium">
        <AlertTriangle className="size-4 text-primary" aria-hidden="true" />
        {profile.label} の要対応 {alerts.length}件{urgent > 0 && <span className="text-xs text-danger">（急ぎ {urgent}件）</span>}
      </summary>
      <ul className="mt-1 space-y-1">
        {alerts.map((a, i) => (
          <li key={i} className={cn("rounded border p-1.5 text-xs", a.urgent && "border-danger")}>
            <p className="font-medium">{a.title}</p>
            <p className="text-muted-foreground">{a.detail}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
