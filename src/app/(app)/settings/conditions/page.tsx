import Link from "next/link";
import { ConditionsView } from "@/components/conditions-view";
import { PageHeading } from "@/components/page-heading";
import { isSupabaseMode } from "@/lib/supabase/env";

export const metadata = { title: "抽選条件管理 | トレマネ" };
export const dynamic = "force-dynamic";

export default function ConditionsPage() {
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <PageHeading navId="settings" className="mb-3">抽選条件管理</PageHeading>
      {isSupabaseMode ? <ConditionsView /> : <p className="text-sm text-muted-foreground">Supabaseモード（ログイン後）でのみ利用できます。</p>}
    </>
  );
}
