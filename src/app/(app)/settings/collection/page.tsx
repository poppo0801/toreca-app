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
  const cols = "id,source_id,title,source_url,status,reasons,draft,lottery_id,fetched_at";
  const cand = () => db.from("collection_candidates").select(cols).order("created_at", { ascending: false }).limit(100);
  const cnt = () => db.from("collection_candidates").select("id", { count: "exact", head: true });
  const [settings, sources, runs, products, monthRuns, newCount, lReview, lQueued, lReg, lEx, lDup, lFail, nReview, nQueued, nReg, nEx, nDup, nFail] = await Promise.all([
    db.from("collection_settings").select("*").limit(1).maybeSingle(),
    db.from("collection_sources").select("*").order("created_at").order("name"),
    db.from("collection_runs").select("id,trigger,status,started_at,finished_at,web_fetched,x_posts,x_calls,ai_calls,new_count,registered_count,error_count,summary").order("started_at", { ascending: false }).limit(10),
    db.from("products").select("id,official_name").is("archived_at", null).order("official_name").limit(1000),
    db.from("collection_runs").select("x_posts,ai_calls").gte("started_at", monthStart),
    db.from("lotteries").select("id", { count: "exact", head: true }).eq("is_new", true).eq("source_kind", "auto"),
    // 確認待ち（解析済み）と解析待ち（一覧から取得しただけでAI読み取り前）を分けて取得する。件数は一覧の表示件数ではなく全件の数
    cand().eq("status", "pending").is("draft->queued", null),
    cand().eq("status", "pending").not("draft->queued", "is", null),
    cand().eq("status", "auto_registered"),
    cand().eq("status", "excluded"),
    cand().eq("status", "duplicate"),
    cand().eq("status", "failed"),
    cnt().eq("status", "pending").is("draft->queued", null),
    cnt().eq("status", "pending").not("draft->queued", "is", null),
    cnt().eq("status", "auto_registered"),
    cnt().eq("status", "excluded"),
    cnt().eq("status", "duplicate"),
    cnt().eq("status", "failed"),
  ]);
  const candidates = [lReview, lQueued, lReg, lEx, lDup, lFail].flatMap((r) => r.data ?? []);
  const counts = { pending: nReview.count ?? 0, queued: nQueued.count ?? 0, auto_registered: nReg.count ?? 0, excluded: nEx.count ?? 0, duplicate: nDup.count ?? 0, failed: nFail.count ?? 0 };
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
        candidates={candidates as unknown as CandidateView[]}
        counts={counts}
        runs={(runs.data ?? []) as unknown as RunView[]}
        products={(products.data ?? []).map((p) => ({ id: p.id, name: p.official_name }))}
        xConfigured={Boolean(process.env.X_BEARER_TOKEN?.trim())}
        aiConfigured={Boolean(process.env.ANTHROPIC_API_KEY?.trim()) || process.env.AI_PROVIDER === "mock"}
        usage={{ xPosts, xCostJpy: estimateCostJpy(xPosts), aiCalls, newAuto: newCount.count ?? 0 }}
      />
    </>
  );
}
