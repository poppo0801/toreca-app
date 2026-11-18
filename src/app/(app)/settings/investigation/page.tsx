import Link from "next/link";
import { notFound } from "next/navigation";
import { InvestigationView } from "@/components/investigation-view";
import { PageHeading } from "@/components/page-heading";
import { isStoreResearchEnabled } from "@/lib/agent/dev-flag";
import { isSupabaseMode } from "@/lib/supabase/env";

export const metadata = { title: "情報収集エージェント（開発用） | トレマネ" };

/** 情報収集エージェントの調査状況（Stage 9D）。開発環境のみ。本番では 404。通常の画面・抽選一覧には影響しない */
export default function InvestigationPage() {
  if (!isStoreResearchEnabled()) notFound();
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <PageHeading navId="settings" className="mb-3">情報収集エージェント（開発用）</PageHeading>
      {isSupabaseMode ? <InvestigationView /> : <p className="text-sm text-muted-foreground">Supabaseモード（ログイン後）でのみ利用できます。</p>}
    </>
  );
}
