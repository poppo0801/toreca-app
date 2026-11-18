import Link from "next/link";
import { notFound } from "next/navigation";
import { LotteryGroupingDevView } from "@/components/lottery-grouping-dev-view";
import { PageHeading } from "@/components/page-heading";
import { isLotteryGroupingEnabled } from "@/lib/agent/lottery-grouping/flags";
import { isSupabaseMode } from "@/lib/supabase/env";

export const metadata = { title: "グループ判定（開発用） | トレマネ" };

/** 抽選グループのAI判定の検証画面（Stage 8F）。開発環境（TOREMANE_ENV=local）のみ。本番では 404 */
export default function LotteryGroupingPage() {
  if (!isLotteryGroupingEnabled()) notFound();
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <PageHeading navId="settings" className="mb-3">グループ判定（開発用）</PageHeading>
      {isSupabaseMode ? <LotteryGroupingDevView /> : <p className="text-sm text-muted-foreground">Supabaseモード（ログイン後）でのみ利用できます。</p>}
    </>
  );
}
