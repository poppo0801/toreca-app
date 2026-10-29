import { NotificationSettings } from "@/components/notification-settings";
import { SubPageHeader } from "@/components/settings-parts";
import { isSupabaseMode } from "@/lib/supabase/env";

export const metadata = { title: "通知設定 | トレマネ" };

export default function NotificationsPage() {
  return (
    <>
      <SubPageHeader title="通知設定" />
      {isSupabaseMode ? <NotificationSettings /> : <p className="text-sm text-muted-foreground">Supabaseモードでのみ利用できます。</p>}
    </>
  );
}
