import { PageHeading } from "@/components/page-heading";
import { SettingsView } from "@/components/settings-view";

export default function SettingsPage() {
  return (
    <>
      <PageHeading navId="settings" className="mb-3">設定</PageHeading>
      <SettingsView />
    </>
  );
}
