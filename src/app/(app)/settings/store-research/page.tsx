import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeading } from "@/components/page-heading";
import { StoreResearchView } from "@/components/store-research-view";
import { isStoreResearchEnabled } from "@/lib/agent/dev-flag";
import { isSupabaseMode } from "@/lib/supabase/env";

export const metadata = { title: "所在地の調査（開発用） | トレマネ" };

/** 店舗所在地エージェントの検証画面（Stage 8D-2）。開発環境のみ。本番では 404 */
export default function StoreResearchPage() {
  if (!isStoreResearchEnabled()) notFound();
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <PageHeading navId="settings" className="mb-3">所在地の調査（開発用）</PageHeading>
      {isSupabaseMode ? <StoreResearchView /> : <p className="text-sm text-muted-foreground">Supabaseモード（ログイン後）でのみ利用できます。</p>}
    </>
  );
}
