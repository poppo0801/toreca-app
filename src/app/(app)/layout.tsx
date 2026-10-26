import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (isSupabaseMode) {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) redirect("/login");
    // 世帯が未作成なら作る（冪等）。以降のクエリはRLSで自世帯のみ。
    await supabase.rpc("bootstrap_household");
  }
  return <AppShell>{children}</AppShell>;
}
