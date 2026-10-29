import Link from "next/link";
import { MasterImportView, type ImportHistoryRow } from "@/components/master-import-view";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Excel取り込み・出力 | トレマネ" };

export default async function MasterImportPage() {
  let history: ImportHistoryRow[] = [];
  if (isSupabaseMode) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("master_import_history")
      .select("id,kind,created_at,file_name,created_count,updated_count,unchanged_count,composition_count")
      .order("created_at", { ascending: false })
      .limit(10);
    history = (data ?? []) as ImportHistoryRow[];
  }
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings/masters" className="underline">
          ← マスター管理
        </Link>
      </p>
      <h1 className="mb-1 text-lg font-bold">Excel取り込み・出力</h1>
      <p className="mb-3 text-xs text-muted-foreground">商品・店舗マスターをExcel（.xlsx）で一括で出力・更新します。</p>
      {isSupabaseMode ? (
        <MasterImportView history={history} />
      ) : (
        <p className="text-sm text-muted-foreground">Excelの取り込み・出力は Supabase モード（ログイン後）でのみ利用できます。</p>
      )}
    </>
  );
}
