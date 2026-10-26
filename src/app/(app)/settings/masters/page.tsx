import Link from "next/link";
import { MastersView, type MasterRows, type RuleRow } from "@/components/masters-view";
import { ENTITY_KEYS } from "@/lib/masters";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "マスター管理 | トレカ抽選管理" };

export default async function MastersPage() {
  if (!isSupabaseMode) {
    return (
      <p className="text-sm text-muted-foreground">
        マスター管理は Supabase モード（NEXT_PUBLIC_DATA_SOURCE=supabase）でのみ利用できます。
      </p>
    );
  }
  const supabase = await createClient();
  const results = await Promise.all(
    ENTITY_KEYS.map((k) => supabase.from(k).select("*").order("created_at")),
  );
  const rules = await supabase.from("profile_target_rules").select("id,profile_id,chain_id,mode");
  const failed = results.find((r) => r.error) ?? (rules.error ? rules : null);
  if (failed) throw new Error("マスターの取得に失敗しました");

  const rows = Object.fromEntries(ENTITY_KEYS.map((k, i) => [k, results[i].data ?? []])) as MasterRows;
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <h1 className="mb-3 text-lg font-bold">マスター管理</h1>
      <MastersView rows={rows} rules={(rules.data ?? []) as RuleRow[]} />
    </>
  );
}
