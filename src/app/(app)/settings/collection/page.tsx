import { PageHeading } from "@/components/page-heading";
import Link from "next/link";
import { AutoCollectView, type CandidateView, type HealthView, type OpsView, type RunView, type SettingsView, type SourceView, type StatRow } from "@/components/auto-collect-view";
import { effectiveDailyLimit, healthWarnings, jstDayString, nextCollectAt } from "@/lib/collector/queue";
import { estimateCostJpy } from "@/lib/collector/x-posts";
import { monthBudget } from "@/lib/server/ai-budget";
import { ensureCollectionDefaults } from "@/lib/server/collector/run";
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
  const now = new Date();
  const today = jstDayString(now);
  const monthStart = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(now)}-01T00:00:00+09:00`).toISOString();
  const endOfToday = new Date(`${today}T23:59:59+09:00`).toISOString();
  const since30 = jstDayString(new Date(now.getTime() - 29 * 86400_000));
  const cols = "id,source_id,title,source_url,status,reasons,draft,lottery_id,fetched_at,job_state,kind,attempts,next_run_at,last_error,due_at,last_changed_at";
  const cand = () => db.from("collection_candidates").select(cols).order("created_at", { ascending: false }).limit(100);
  const cnt = () => db.from("collection_candidates").select("id", { count: "exact", head: true });
  const [settings, sources, runs, products, monthRuns, newCount, lReview, lQueued, lReg, lEx, lDup, lFail, nReview, nQueued, nProc, nReg, nEx, nDup, nFail, oldest, failed24, lastCollect, lastWorker, running, stats, budget, dueToday, lastProgress] = await Promise.all([
    db.from("collection_settings").select("*").limit(1).maybeSingle(),
    db.from("collection_sources").select("*").order("created_at").order("name"),
    db.from("collection_runs").select("id,trigger,phase,status,started_at,finished_at,web_fetched,x_posts,x_calls,ai_calls,new_count,registered_count,error_count,processed_count,changed_count,skipped_count,stop_reason,summary").order("started_at", { ascending: false }).limit(10),
    db.from("products").select("id,official_name").is("archived_at", null).order("official_name").limit(1000),
    db.from("collection_runs").select("x_posts").gte("started_at", monthStart),
    db.from("lotteries").select("id", { count: "exact", head: true }).eq("is_new", true).eq("source_kind", "auto"),
    // 状態ごと。件数は一覧の表示件数ではなく全件の数
    cand().eq("job_state", "review"),
    cand().in("job_state", ["pending", "retry", "processing"]),
    cand().eq("status", "auto_registered"),
    cand().eq("job_state", "skipped"),
    cand().eq("status", "duplicate"),
    cand().eq("job_state", "failed"),
    cnt().eq("job_state", "review"),
    cnt().in("job_state", ["pending", "retry", "processing"]),
    cnt().eq("job_state", "processing"),
    cnt().eq("status", "auto_registered"),
    cnt().eq("job_state", "skipped"),
    cnt().eq("status", "duplicate"),
    cnt().eq("job_state", "failed"),
    db.from("collection_candidates").select("created_at").in("job_state", ["pending", "retry", "processing"]).order("created_at").limit(1).maybeSingle(),
    db.from("collection_candidates").select("id", { count: "exact", head: true }).in("job_state", ["failed", "retry"]).gte("started_at", new Date(now.getTime() - 86400_000).toISOString()),
    db.from("collection_runs").select("started_at,finished_at,status").eq("phase", "collect").eq("status", "done").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("collection_runs").select("started_at,finished_at,status,stop_reason").eq("phase", "worker").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("collection_runs").select("id", { count: "exact", head: true }).eq("status", "running"),
    db.from("collection_daily_stats").select("*").gte("day", since30).order("day", { ascending: false }),
    monthBudget(db),
    cnt().in("job_state", ["pending", "retry", "processing"]).gt("due_at", now.toISOString()).lte("due_at", endOfToday),
    db.from("collection_candidates").select("completed_at").not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const candidates = [lReview, lQueued, lReg, lEx, lDup, lFail].flatMap((r) => r.data ?? []);
  const counts = { pending: nReview.count ?? 0, queued: nQueued.count ?? 0, auto_registered: nReg.count ?? 0, excluded: nEx.count ?? 0, duplicate: nDup.count ?? 0, failed: nFail.count ?? 0 };
  const xPosts = (monthRuns.data ?? []).reduce((a, r) => a + r.x_posts, 0);
  const st = settings.data!;
  const srcs = (sources.data ?? []) as unknown as SourceView[];
  const statRows = (stats.data ?? []) as unknown as StatRow[];
  const todayRow = statRows.find((r) => r.day === today);
  const daily = effectiveDailyLimit(st as never, now);
  const dailyUsed = todayRow?.ai_calls ?? 0;
  const lastWorkerAt = lastWorker.data?.started_at ? new Date(lastWorker.data.started_at) : null;
  const lastCollectAt = lastCollect.data?.started_at ? new Date(lastCollect.data.started_at) : null;
  const lastProgressAt = lastProgress.data?.completed_at ? new Date(lastProgress.data.completed_at) : null;
  const paused = Boolean(st.paused_until && new Date(st.paused_until) > now);
  const warnings = healthWarnings({
    now,
    workerEnabled: st.worker_enabled,
    queued: counts.queued,
    oldestQueuedAt: oldest.data?.created_at ? new Date(oldest.data.created_at) : null,
    lastWorkerAt,
    lastProgressAt,
    failedLast24h: failed24.count ?? 0,
    pausedReason: paused ? st.paused_reason : null,
    sources: srcs.map((s) => ({ name: s.name, enabled: s.enabled && s.kind === "web", lastSuccessAt: s.last_success_at ? new Date(s.last_success_at) : null, consecutiveFailures: s.consecutive_failures ?? 0 })),
    scheduleEnabled: st.schedule_enabled,
    lastCollectAt,
    dailyUsed,
    dailyLimit: daily.limit,
    budgetBlocked: budget.blocked,
    dueTodayQueued: dueToday.count ?? 0,
  });
  const limitReached = dailyUsed >= daily.limit;
  const state: HealthView["state"] = (running.count ?? 0) > 0 ? "running" : paused ? "paused" : budget.blocked && counts.queued > 0 ? "budget" : limitReached && counts.queued > 0 ? "limit" : counts.queued > 0 ? "waiting" : "ok";
  const health: HealthView = {
    state,
    warnings: warnings.map((w) => w.message),
    lastCollectAt: lastCollectAt?.toISOString() ?? null,
    lastWorkerAt: lastWorkerAt?.toISOString() ?? null,
    nextCollectAt: st.schedule_enabled ? nextCollectAt(now, st.schedule_hour_jst).toISOString() : null,
    processing: nProc.count ?? 0,
    pausedReason: paused ? st.paused_reason : null,
    workerDayUsed: dailyUsed,
  };
  const ops: OpsView = {
    todayDiscovered: (todayRow?.discovered_new ?? 0) + (todayRow?.discovered_initial ?? 0),
    todayDiscoveredInitial: todayRow?.discovered_initial ?? 0,
    todayAi: dailyUsed,
    dailyLimit: daily.limit,
    baseLimit: st.worker_daily_ai_limit,
    overridden: daily.overridden,
    todayRegistered: todayRow?.registered_new ?? 0,
    monthCostJpy: Math.round(budget.costJpy * 10) / 10,
    budgetJpy: budget.budgetJpy,
    rate: budget.rate,
    avgPerCallJpy: budget.avgPerCallJpy,
    monthCalls: budget.calls,
    budgetBlocked: budget.blocked,
    lastProgressAt: lastProgressAt?.toISOString() ?? null,
    dueTodayQueued: dueToday.count ?? 0,
  };
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/settings" className="underline">
          ← 設定
        </Link>
      </p>
      <PageHeading navId="settings" className="mb-3">抽選情報の自動収集</PageHeading>
      <AutoCollectView
        settings={st as unknown as SettingsView}
        sources={srcs}
        candidates={candidates as unknown as CandidateView[]}
        counts={counts}
        health={health}
        ops={ops}
        stats={statRows}
        runs={(runs.data ?? []) as unknown as RunView[]}
        products={(products.data ?? []).map((p) => ({ id: p.id, name: p.official_name }))}
        xConfigured={Boolean(process.env.X_BEARER_TOKEN?.trim())}
        aiConfigured={Boolean(process.env.ANTHROPIC_API_KEY?.trim()) || process.env.AI_PROVIDER === "mock"}
        usage={{ xPosts, xCostJpy: estimateCostJpy(xPosts), aiCalls: budget.calls, newAuto: newCount.count ?? 0 }}
      />
    </>
  );
}
