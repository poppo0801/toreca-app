import { CandidatesView } from "@/components/candidates-view";
import type { CandidateView } from "@/components/auto-collect-view";
import { assessRow, importantChains } from "@/lib/collector/assess-row";
import { closedReviewIds } from "@/lib/server/collector/closed-ids";
import { conditionsFromRow } from "@/lib/server/collector/run";
import { loadAppData } from "@/lib/server/lottery-service";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "抽選候補 | トレマネ" };
export const dynamic = "force-dynamic";

/**
 * 抽選候補（自動収集の確認待ち）。設定の「抽選情報の自動収集」と同じ候補（collection_candidates）を、抽選管理と同じカード形式で処理する。
 * 情報充実度・対応優先度は、表示のたびに保存済みの草稿と最新のマスターから再計算する（設定画面と同じ assessRow）。
 */
export default async function CandidatesPage() {
  if (!isSupabaseMode) return <p className="text-sm text-muted-foreground">抽選候補はSupabaseモード（ログイン後）でのみ利用できます。</p>;
  const db = await createClient();
  const hh = await db.from("households").select("id").maybeSingle();
  if (!hh.data) return <p className="text-sm text-muted-foreground">世帯が見つかりません。</p>;
  const now = new Date();
  const cols = "id,source_id,title,source_url,status,reasons,draft,lottery_id,fetched_at,job_state,kind,attempts,next_run_at,last_error,due_at,last_changed_at,memo_id,triage,manual_state,manual_reason";
  const [rev, settings, closed, appData] = await Promise.all([
    db.from("collection_candidates").select(cols).eq("job_state", "review").in("status", ["pending", "failed"]).is("lottery_id", null).order("created_at", { ascending: false }).limit(500),
    db.from("collection_settings").select("*").limit(1).maybeSingle(),
    closedReviewIds(db as never, now).catch(() => new Set<string>()),
    loadAppData(db as never, hh.data.id).catch(() => null),
  ]);
  if (rev.error) return <p className="text-sm text-danger" role="alert">抽選候補を読み込めませんでした。通信を確認して、画面を再読み込みしてください。</p>;
  const important = appData ? importantChains(appData) : new Set<string>();
  const cond = settings.data ? conditionsFromRow(settings.data as unknown as Record<string, unknown>) : null;
  const candidates = (rev.data ?? [])
    .filter((c) => !closed.has(c.id))
    .map((c) => ({ ...c, assess: appData && cond ? assessRow({ draft: c.draft, due_at: c.due_at, source_url: c.source_url, memo_id: (c as { memo_id?: string | null }).memo_id }, appData, now, important, cond) : null }));
  return <CandidatesView candidates={candidates as unknown as CandidateView[]} />;
}
