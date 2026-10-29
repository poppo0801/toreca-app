import { ProfileSettings } from "@/components/profile-settings";
import { SettingsCopy } from "@/components/settings-copy";
import { SubPageHeader } from "@/components/settings-parts";

export const metadata = { title: "ユーザー管理 | トレマネ" };

export default function UsersPage() {
  return (
    <>
      <SubPageHeader
        title="ユーザー管理"
        description="操作中のユーザーはヘッダー右上のアイコンからも切り替えられます。選択はこの端末のみに保存され、他の端末とは同期しません（本人認証ではなく「誰として記録するか」の選択です）。"
      />
      <div className="space-y-4">
        <ProfileSettings />
        <section className="rounded-xl border bg-card p-3" aria-labelledby="copy-title">
          <h2 id="copy-title" className="mb-2 text-sm font-bold">
            設定のコピー
          </h2>
          <SettingsCopy />
        </section>
      </div>
    </>
  );
}
