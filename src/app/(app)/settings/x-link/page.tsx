import { XLinkView, type XLinkInfo } from "@/components/x-link-view";
import { SubPageHeader } from "@/components/settings-parts";
import { estimateCostJpy } from "@/lib/collector/x-posts";
import { oauthConfigStatus } from "@/lib/server/x-oauth-server";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Xアカウント連携 | トレマネ" };
export const dynamic = "force-dynamic";

const jstMonthStart = (now: Date) => new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(now)}-01T00:00:00+09:00`).toISOString();

export default async function XLinkPage({ searchParams }: { searchParams: Promise<{ x?: string; m?: string }> }) {
  const sp = await searchParams;
  if (!isSupabaseMode) {
    return (
      <>
        <SubPageHeader title="Xアカウント連携" />
        <p className="text-sm text-muted-foreground">Supabaseモード（ログイン後）でのみ利用できます。</p>
      </>
    );
  }
  const db = await createClient();
  // 利用者から読めるのは連携の状態だけ（トークンは別の表で、ログイン中の利用者には読めない）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
  const anyDb = db as any;
  const [linkRes, setRes, runsRes] = await Promise.all([
    anyDb.from("x_bookmark_links").select("x_username,status,auto_sync,last_synced_at,last_sync_result,last_error,initial_synced_at").maybeSingle(),
    db.from("collection_settings").select("x_enabled,x_monthly_budget_jpy").limit(1).maybeSingle(),
    db.from("collection_runs").select("x_posts,phase").gte("started_at", jstMonthStart(new Date())),
  ]);
  const runs = (runsRes.data ?? []) as { x_posts: number; phase: string }[];
  const bookmarkPosts = runs.filter((r) => r.phase === "bookmark").reduce((a, r) => a + r.x_posts, 0);
  const totalPosts = runs.reduce((a, r) => a + r.x_posts, 0);
  const l = linkRes.data as { x_username: string; status: "active" | "needs_reauth"; auto_sync: boolean; last_synced_at: string | null; last_sync_result: string; last_error: string; initial_synced_at: string | null } | null;
  const cfg = oauthConfigStatus();
  const info: XLinkInfo = {
    configured: cfg.clientId && cfg.clientSecret && cfg.encryptionKey,
    link: l ? { username: l.x_username, status: l.status, autoSync: l.auto_sync, lastSyncedAt: l.last_synced_at, lastResult: l.last_sync_result, lastError: l.last_error, initialDone: !!l.initial_synced_at } : null,
    xEnabled: !!setRes.data?.x_enabled,
    budgetJpy: setRes.data?.x_monthly_budget_jpy ?? 0,
    bookmarkPosts,
    bookmarkCostJpy: estimateCostJpy(bookmarkPosts),
    totalCostJpy: estimateCostJpy(totalPosts),
  };
  return (
    <>
      <SubPageHeader title="Xアカウント連携" />
      <XLinkView info={info} result={sp.x ?? null} message={sp.m ?? null} />
    </>
  );
}
