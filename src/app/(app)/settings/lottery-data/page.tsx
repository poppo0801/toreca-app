import Link from "next/link";
import { LotteryDataView, type LotteryImportHistoryRow } from "@/components/lottery-data-view";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "抽選データ管理 | トレマネ" };

export default async function LotteryDataPage() {
  let history: LotteryImportHistoryRow[] = [];
  if (isSupabaseMode) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("lottery_import_history")
      .select("id,created_at,file_name,created_count,updated_count,unchanged_count,application_count")
      .order("created_at", { ascending: false })
      .limit(10);
    history = (data ?? []) as LotteryImportHistoryRow[];
  }
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <h1 className="mb-3 text-lg font-bold">抽選データ管理</h1>
      {isSupabaseMode ? <LotteryDataView history={history} /> : <p className="text-sm text-muted-foreground">Excelの取り込み・出力は Supabase モード（ログイン後）でのみ利用できます。</p>}
    </>
  );
}
