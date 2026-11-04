import { PageHeading } from "@/components/page-heading";
import Link from "next/link";
import { RulesView } from "@/components/rules-view";
import { isSupabaseMode } from "@/lib/supabase/env";

export const metadata = { title: "応募ルール | トレマネ" };

export default function RulesPage() {
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <PageHeading navId="settings" className="mb-3">応募ルール・スルー</PageHeading>
      {isSupabaseMode ? <RulesView /> : <p className="text-sm text-muted-foreground">Supabaseモード（ログイン後）でのみ利用できます。</p>}
    </>
  );
}
