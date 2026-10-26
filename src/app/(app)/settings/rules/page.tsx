import Link from "next/link";
import { RulesView } from "@/components/rules-view";
import { isSupabaseMode } from "@/lib/supabase/env";

export const metadata = { title: "応募ルール | トレカ抽選管理" };

export default function RulesPage() {
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <h1 className="mb-3 text-lg font-bold">応募ルール・スルー</h1>
      {isSupabaseMode ? <RulesView /> : <p className="text-sm text-muted-foreground">Supabaseモード（ログイン後）でのみ利用できます。</p>}
    </>
  );
}
