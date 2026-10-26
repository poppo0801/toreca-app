import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import type { Profile, ProfileColor } from "@/types/domain";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!isSupabaseMode) return <AppShell>{children}</AppShell>;

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  // 世帯が未作成なら作る（冪等）。以降のクエリはRLSで自世帯のみ。
  await supabase.rpc("bootstrap_household");
  const { data: rows, error } = await supabase
    .from("profiles")
    .select("id,label,initial,color")
    .eq("active", true)
    .order("sort_order")
    .order("created_at");
  if (error) throw new Error("プロフィールの取得に失敗しました");

  const profiles: Profile[] = (rows ?? []).map((r) => ({
    id: r.id,
    label: r.label,
    initial: r.initial,
    color: r.color as ProfileColor,
    allowedChainIds: null,
    blockedChainIds: [],
  }));
  if (profiles.length === 0) throw new Error("有効なプロフィールがありません。設定で有効化してください");

  return <AppShell profiles={profiles}>{children}</AppShell>;
}
