"use client";

import Link from "next/link";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { signOut } from "@/app/login/actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { AiQualitySection, AiUsageSection, CardDisplaySection, HomeLocationSection } from "@/components/household-settings";
import { Accordion, MenuGroup, MenuLink } from "@/components/settings-parts";
import { setDiagEnabled } from "@/components/layout-diagnostics";

const SUPABASE = IS_SUPABASE_MODE;

/**
 * 設定: 見出しだけの一覧。小さな項目はその場で開き（アコーディオン）、大きな項目は別ページへ移る。
 * 以前の設定画面にあった項目はすべて、ここから辿れる。
 */
export function SettingsView() {
  const { data, profile } = useApp();
  return (
    <div className="space-y-4" data-testid="settings-menu">
      <MenuGroup>
        <MenuLink href="/settings/users" title="ユーザー管理" testId="menu-users" />
        <MenuLink href="/settings/display" title="メニュー・表示設定" testId="menu-display" />
      </MenuGroup>

      <MenuGroup label="データ">
        {SUPABASE ? (
          <>
            <MenuLink href="/settings/masters" title="マスター管理" testId="menu-masters" />
            <MenuLink href="/settings/rules" title="応募ルール・スルー" testId="menu-rules" />
          </>
        ) : (
          <p className="px-3 py-3 text-sm text-muted-foreground">マスター管理・応募ルールはSupabaseモード（ログイン後）で利用できます。</p>
        )}
        <Accordion title="記録・分析" testId="acc-records">
          <div className="flex flex-wrap gap-2">
            {SUPABASE && (
              <Button asChild variant="outline">
                <Link href="/battles">対戦記録</Link>
              </Button>
            )}
            <Button asChild variant="outline">
              <Link href="/records">応募実績・当選率</Link>
            </Button>
          </div>
        </Accordion>
      </MenuGroup>

      <MenuGroup label="位置・通知・AI">
        {SUPABASE ? (
          <>
            <Accordion title="自宅・位置情報" testId="acc-location">
              <div className="space-y-5">
                <HomeLocationSection />
                <CardDisplaySection />
              </div>
            </Accordion>
            <MenuLink href="/settings/notifications" title="通知設定" testId="menu-notifications" />
            <Accordion title="AI利用状況・フィードバック" testId="acc-ai">
              <div className="space-y-5">
                <AiUsageSection />
                <AiQualitySection />
              </div>
            </Accordion>
          </>
        ) : (
          <p className="px-3 py-3 text-sm text-muted-foreground">位置情報・通知・AIの設定はSupabaseモードで利用できます。</p>
        )}
      </MenuGroup>

      <MenuGroup label="その他">
        <Accordion title="データ管理・バックアップ" testId="acc-data">
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              {SUPABASE
                ? "バックアップはサーバー側のコマンド（npm run backup）で取得します。マスターのExcel出力は「マスター管理」から行えます。"
                : "ローカルモック（架空データ・リロードで初期化）です。"}
            </p>
            <h3 className="text-[13px] font-medium">{SUPABASE ? "操作履歴（直近50件・全員共通）" : "抽選の操作履歴（デモ・このセッションのみ）"}</h3>
            {data.audit.length === 0 ? (
              <p className="text-xs text-muted-foreground">まだ操作はありません。★や応募を操作すると記録されます。</p>
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
          </div>
        </Accordion>
        <Accordion title="アプリについて・ログアウト" testId="acc-about">
          <div className="space-y-2 text-sm">
            <p>{SUPABASE ? "Supabase（ログイン・プロフィール・マスター・抽選は実データ）。" : "ローカルモック（架空データ・リロードで初期化）。"}</p>
            <p className="text-xs text-muted-foreground">現在の操作プロフィール: {profile.label}</p>
            <p className="text-xs text-muted-foreground">操作中のユーザーはヘッダー右上のアイコンからも切り替えられます（この端末にのみ保存され、本人認証ではありません）。</p>
            <button
              type="button"
              data-testid="diag-start"
              onClick={() => {
                setDiagEnabled(true);
                window.location.reload();
              }}
              className="min-h-10 rounded-md border px-3 text-xs"
            >
              表示診断を開始（下部メニューの位置の確認用）
            </button>
            {SUPABASE && (
              <form action={signOut}>
                <Button type="submit" variant="outline">
                  ログアウト
                </Button>
              </form>
            )}
          </div>
        </Accordion>
      </MenuGroup>
    </div>
  );
}
