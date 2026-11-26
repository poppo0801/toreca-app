import { CandidatesView } from "@/components/candidates-view";
import type { CandidateView } from "@/components/auto-collect-view";
import { assessRow, importantChains } from "@/lib/collector/assess-row";
import { closedReviewIds } from "@/lib/server/collector/closed-ids";
import { NOT_INTERNAL_TEASER } from "@/lib/collector/teaser-filter";
import { conditionsFromRow } from "@/lib/server/collector/run";
import { loadAppData } from "@/lib/server/lottery-service";
import { proposalPreviewEnabled, proposalShadowViewEnabled } from "@/lib/server/proposals/flag";
import { loadProposals } from "@/lib/server/proposals/store";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "抽選候補 | トレマネ" };
export const dynamic = "force-dynamic";

/**
 * 抽選候補（自動収集の確認待ち）。設定の「抽選情報の自動収集」と同じ候補（collection_candidates）を、抽選管理と同じカード形式で処理する。
 * 情報充実度・対応優先度は、表示のたびに保存済みの草稿と最新のマスターから再計算する（設定画面と同じ assessRow）。
 */
export default async function CandidatesPage({ searchParams }: { searchParams?: Promise<{ scope?: string }> }) {
  if (!isSupabaseMode) return <p className="text-sm text-muted-foreground">抽選候補はSupabaseモード（ログイン後）でのみ利用できます。</p>;
  const db = await createClient();
  const hh = await db.from("households").select("id").maybeSingle();
  if (!hh.data) return <p className="text-sm text-muted-foreground">世帯が見つかりません。</p>;
  const now = new Date();
  const cols = "id,source_id,title,source_url,status,reasons,draft,lottery_id,fetched_at,job_state,kind,attempts,next_run_at,last_error,due_at,last_changed_at,memo_id,triage,manual_state,manual_reason";
  const [rev, settings, closed, appData] = await Promise.all([
    db.from("collection_candidates").select(cols).eq("job_state", "review").in("status", ["pending", "failed"]).is("lottery_id", null).or(NOT_INTERNAL_TEASER).order("created_at", { ascending: false }).limit(500),
    db.from("collection_settings").select("*").limit(1).maybeSingle(),
    closedReviewIds(db as never, now).catch(() => new Set<string>()),
    loadAppData(db as never, hh.data.id).catch(() => null),
  ]);
  if (rev.error) return <p className="text-sm text-danger" role="alert">抽選候補を読み込めませんでした。通信を確認して、画面を再読み込みしてください。</p>;
  const important = appData ? importantChains(appData) : new Set<string>();
  const cond = settings.data ? conditionsFromRow(settings.data as unknown as Record<string, unknown>) : null;
  // 新AIの評価（INTENSIVE_EVALUATION §1）: 管理用の範囲 scope=eval では、確認待ちに加えて、登録案のある候補・最近の処理済み/失敗/除外の候補（登録案なし＝取りこぼしの確認用）も読む。
  // 通常の表示（scope なし）は従来どおり確認待ちだけ。新AIの表示が無効なときは scope を無視する
  const evalScope = (proposalPreviewEnabled() || proposalShadowViewEnabled()) && (await searchParams)?.scope === "eval";
  const extra: typeof rev.data = [];
  if (evalScope) {
    const seen = new Set((rev.data ?? []).map((c) => c.id));
    const withProps = ((await db.from("registration_proposals").select("candidate_id").is("superseded_at", null).order("created_at", { ascending: false }).limit(300)).data ?? []).map((r) => r.candidate_id as string);
    const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
    const recent = ((await db.from("collection_candidates").select("id").neq("job_state", "review").gte("created_at", since).or(NOT_INTERNAL_TEASER).order("created_at", { ascending: false }).limit(200)).data ?? []).map((r) => r.id as string);
    const ids = [...new Set([...withProps, ...recent])].filter((id) => !seen.has(id)).slice(0, 400);
    for (let i = 0; i < ids.length; i += 100) extra.push(...(((await db.from("collection_candidates").select(cols).in("id", ids.slice(i, i + 100))).data ?? []) as NonNullable<typeof rev.data>));
  }
  const candidates = [...(rev.data ?? []), ...(extra ?? [])]
    .filter((c) => evalScope || !closed.has(c.id))
    .map((c) => ({ ...c, assess: appData && cond ? assessRow({ draft: c.draft, due_at: c.due_at, source_url: c.source_url, memo_id: (c as { memo_id?: string | null }).memo_id }, appData, now, important, cond) : null }));
  // 新AIの登録案（プレビュー）。開発専用・既定OFF（ローカル環境かつ PROPOSAL_PREVIEW=on のときだけ読む。本番では常に無効）
  const shadowView = proposalShadowViewEnabled(); // 本番シャドー: 読み取り（現行の候補と並べて見る）とレビューの記録だけ。登録案の生成は画面から行えない
  const preview = proposalPreviewEnabled() || shadowView;
  const proposals = preview ? await loadProposals(db as never, candidates.map((c) => c.id)).catch(() => ({})) : undefined;
  return <CandidatesView candidates={candidates as unknown as CandidateView[]} proposals={proposals} proposalPreview={preview} proposalShadow={shadowView} evalScope={evalScope} />;
}
