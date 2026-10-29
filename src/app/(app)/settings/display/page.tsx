import { DisplaySettings } from "@/components/display-settings";
import { SubPageHeader } from "@/components/settings-parts";

export const metadata = { title: "メニュー・表示設定 | トレマネ" };

export default function DisplayPage() {
  return (
    <>
      <SubPageHeader title="メニュー・表示設定" />
      <DisplaySettings />
    </>
  );
}
