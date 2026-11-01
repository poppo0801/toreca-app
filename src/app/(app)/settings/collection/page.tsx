import Link from "next/link";
import { AutoCollectView, type CandidateView, type RunView, type SettingsView, type SourceView } from "@/components/auto-collect-view";
import { ensureCollectionDefaults } from "@/lib/server/collector/run";
import { estimateCostJpy } from "@/lib/collector/x-posts";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "抽選情報の自動収集 | トレマネ" };
export const dynamic = "force-dynamic";

export default async function CollectionPage() {
  if (!isSupabaseMode) {
    return <p className="text-sm text-muted-foreground">自動収集はSupabaseモード（ログイン後）でのみ利用できます。</p>;
  }
  const db = await createClient();
  const hh = await db.from("households").select("id").maybeSingle();
  if (!hh.data) return <p className="text-sm text-muted-foreground">世帯が見つかりません。</p>;
  await ensureCollectionDefaults(db, hh.data.id);
  const monthStart = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(new Date())}-01T00:00:00+09:00`).toISOString();
  const [settings, sources, candidates, runs, products, monthRuns, newCount] = await Promise.all([
    db.from("collection_settings").select("*").limit(1).maybeSingle(),
    db.from("collection_sources").select("*").order("created_at").order("name"),
    db.from("collection_candidates").select("id,source_id,title,source_url,status,reasons,draft,lottery_id,fetched_at").order("created_at", { ascending: false }).limit(150),
    db.from("collection_runs").select("id,trigger,status,started_at,finished_at,web_fetched,x_posts,x_calls,ai_calls,new_count,registered_count,error_count,summary").order("started_at", { ascending: false }).limit(10),
    db.from("products").select("id,official_name").is("archived_at", null).order("official_name").limit(1000),
    db.from("collection_runs").select("x_posts,ai_calls").gte("started_at", monthStart),
    db.from("lotteries").select("id", { count: "exact", head: true }).eq("is_new", true).eq("source_kind", "auto"),
  ]);
  const xPosts = (monthRuns.data ?? []).reduce((a, r) => a + r.x_posts, 0);
  const aiCalls = (monthRuns.data ?? []).reduce((a, r) => a + r.ai_calls, 0);
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <h1 className="mb-3 text-lg font-bold">抽選情報の自動収集</h1>
      <AutoCollectView
        settings={settings.data as unknown as SettingsView}
        sources={(sources.data ?? []) as unknown as SourceView[]}
        candidates={(candidates.data ?? []) as unknown as CandidateView[]}
        runs={(runs.data ?? []) as unknown as RunView[]}
        products={(products.data ?? []).map((p) => ({ id: p.id, name: p.official_name }))}
        xConfigured={Boolean(process.env.X_BEARER_TOKEN?.trim())}
        aiConfigured={Boolean(process.env.ANTHROPIC_API_KEY?.trim()) || process.env.AI_PROVIDER === "mock"}
        usage={{ xPosts, xCostJpy: estimateCostJpy(xPosts), aiCalls, newAuto: newCount.count ?? 0 }}
      />
    </>
  );
}
