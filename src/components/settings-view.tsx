"use client";

import Link from "next/link";
import { signOut } from "@/app/login/actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { NotificationSettings } from "@/components/notification-settings";
import { ProfileAvatar } from "@/components/profile-avatar";
import { ProfileSwitcher } from "@/components/profile-switcher";
import { ThemeToggle } from "@/components/theme-toggle";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-3">
      <h2 className="mb-2 text-sm font-bold">{title}</h2>
      {children}
    </section>
  );
}

const SUPABASE = process.env.NEXT_PUBLIC_DATA_SOURCE === "supabase";

export function SettingsView() {
  const { data, profile } = useApp();
  return (
    <div className="space-y-4">
      <Section title="操作プロフィール">
        <p className="mb-2 text-xs text-muted-foreground">
          選択は<strong>この端末のみ</strong>に保存され、他の端末とは同期しません。本人認証ではなく、操作履歴に残す「誰として操作したか」の選択です。
        </p>
        <ProfileSwitcher />
        <ul className="mt-3 space-y-2 text-sm">
          {data.profiles.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <ProfileAvatar profile={p} />
              <span>プロフィール{p.label}</span>
              <span className="text-xs text-muted-foreground">
                {SUPABASE ? "応募対象はマスター管理で設定" : p.allowedChainIds === null
                  ? "全系列が対象"
                  : `許可リスト: ${p.allowedChainIds.map((id) => data.chains.find((c) => c.id === id)?.name).join("、")}`}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="マスター管理">
        {SUPABASE ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground">系列・店舗・商品・応募名義・応募アカウント・プロフィールを登録します。</p>
            <Button asChild variant="outline">
              <Link href="/settings/masters">マスター管理を開く</Link>
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Supabaseモードでのみ利用できます（現在はローカルモック）。</p>
        )}
      </Section>

      <Section title="応募ルール・スルー">
        {SUPABASE ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground">店舗・系列単位のスルー、系列の標準の応募制限（1人1回・1家族1回など）を管理します。</p>
            <Button asChild variant="outline">
              <Link href="/settings/rules">応募ルールを開く</Link>
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Supabaseモードでのみ利用できます。</p>
        )}
      </Section>

      <Section title="通知">
        {SUPABASE ? <NotificationSettings /> : <p className="text-sm text-muted-foreground">Supabaseモードでのみ利用できます。</p>}
      </Section>

      <Section title="テーマ">
        <ThemeToggle />
      </Section>

      <Section title={SUPABASE ? "操作履歴（直近50件・全員共通）" : "抽選の操作履歴（デモ・このセッションのみ）"}>
        {data.audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">まだ操作はありません。★や応募を操作すると記録されます。</p>
        ) : (
          <ul className="space-y-1 text-xs" data-testid="audit-list">
            {data.audit.slice(0, 20).map((e) => (
              <li key={e.id}>
                {new Date(e.at).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" })} ・ プロフィール
                {data.profiles.find((p) => p.id === e.actorProfileId)?.label} ・ {e.entityType} / {e.action}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="現在のモード">
        <p className="text-sm">
          {SUPABASE
            ? "Supabase（ログイン・プロフィール・マスターは実データ）。抽選一覧はデモデータで、Stage 2でDB化します。"
            : "ローカルモック（架空データ・リロードで初期化）。"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">現在の操作プロフィール: {profile.label}</p>
        {SUPABASE && (
          <form action={signOut} className="mt-3">
            <Button type="submit" variant="outline">
              ログアウト
            </Button>
          </form>
        )}
      </Section>
    </div>
  );
}
