/**
 * シャドーの待ち行列の優先順位（EVIDENCE_UTILIZATION。AIは呼ばない・費用0）。
 *  - 日次の予算（1日に処理できるのは十数件）に対して待ちが増え続けると、古い順の処理では締切直前・新規の候補が後回しになる。
 *  - リース（DB関数 shadow_lease）は next_run_at の順に確保する。ここでは、待ちのジョブの next_run_at を優先度に合わせて動かすだけで、DBの移行は要らない。
 *  - 締切を過ぎた候補（旧方式の登録値の締切が日本時間の今日より前）のジョブは、AIを呼ばずに skipped（deadline_passed）にする。候補・抽選のデータは変えない（シャドーのジョブだけ）。
 *  - 一律の再実行・削除はしない。判別できない（締切が不明）ものは通常の順番のまま。
 */
export type QueueTier = 0 | 1 | 2;
export type QueueDecision = { action: "skip"; reason: "deadline_passed" } | { action: "keep"; tier: QueueTier };

export interface QueueCandidateView {
  status: string | null;
  /** 旧方式の登録値の締切（YYYY-MM-DD・日本時間）。不明は null */
  deadline: string | null;
  /** この候補に新AIの登録案が既にあるか */
  evaluatedBefore: boolean;
}

const jstDay = (d: Date): string => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string): number => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);

/** 1件の判定（純関数） */
export function queueDecision(c: QueueCandidateView, now: Date): QueueDecision {
  const today = jstDay(now);
  if (c.deadline && /^\d{4}-\d{2}-\d{2}$/.test(c.deadline) && c.deadline < today) return { action: "skip", reason: "deadline_passed" };
  const left = c.deadline ? daysBetween(today, c.deadline) : null;
  // 締切が3日以内・旧方式で確認待ち（人の判断を待っている）・まだ一度も新AIで評価していない候補を先に
  if ((left !== null && left <= 3) || c.status === "pending" || !c.evaluatedBefore) return { action: "keep", tier: 0 };
  // 旧方式で除外・重複と判断済みで、新AIでも評価済みの候補は後に（再評価の価値が相対的に低い）
  if (c.status === "excluded" || c.status === "duplicate") return { action: "keep", tier: 2 };
  return { action: "keep", tier: 1 };
}

/** 優先度に応じた次回の確保時刻。tier0 は作成時刻の1日前（古い通常のジョブより先）、tier2 は少なくとも6時間後 */
export function nextRunFor(tier: QueueTier, job: { created_at: string; next_run_at: string }, now: Date): string | null {
  if (tier === 0) {
    const t = new Date(new Date(job.created_at).getTime() - 86_400_000).toISOString();
    return t < job.next_run_at ? t : null;
  }
  if (tier === 2) {
    const t = new Date(now.getTime() + 6 * 3_600_000).toISOString();
    return job.next_run_at < t ? t : null;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = { from: (n: string) => any };

/** 期限の来た待ちのジョブ（最大 limit 件）に優先度をつける。失敗しても例外を出さない（ワーカーは従来の順で続ける） */
export async function prioritizeShadowQueue(db: unknown, now: Date, limit = 120): Promise<{ checked: number; skipped: number; raised: number; lowered: number }> {
  const out = { checked: 0, skipped: 0, raised: 0, lowered: 0 };
  try {
    const t = (n: string) => (db as Loose).from(n);
    // 期限の来たジョブだけ（予算・間隔で先送りしたジョブを前へ戻して空回りさせない）
    const q = await t("shadow_jobs").select("id,household_id,candidate_id,created_at,next_run_at,last_error").eq("status", "queued").lte("next_run_at", now.toISOString()).order("next_run_at", { ascending: true }).limit(limit);
    const jobs = (q.data ?? []) as { id: string; household_id: string; candidate_id: string; created_at: string; next_run_at: string; last_error: string | null }[];
    if (!jobs.length) return out;
    const ids = [...new Set(jobs.map((j) => j.candidate_id))];
    const cands = ((await t("collection_candidates").select("id,status,draft").in("id", ids)).data ?? []) as { id: string; status: string | null; draft: { input?: { applyDeadline?: { date?: string | null } } } | null }[];
    const props = ((await t("registration_proposals").select("candidate_id").eq("mode", "real").in("candidate_id", ids)).data ?? []) as { candidate_id: string }[];
    const evaluated = new Set(props.map((p) => p.candidate_id));
    const byId = new Map(cands.map((c) => [c.id, c]));
    for (const j of jobs) {
      const c = byId.get(j.candidate_id);
      if (!c) continue;
      out.checked++;
      const d = queueDecision({ status: c.status, deadline: c.draft?.input?.applyDeadline?.date ?? null, evaluatedBefore: evaluated.has(j.candidate_id) }, now);
      if (d.action === "skip") {
        const r = await t("shadow_jobs").update({ status: "skipped", skip_reason: d.reason, updated_at: now.toISOString() }).eq("id", j.id).eq("status", "queued");
        if (!r.error) out.skipped++;
        continue;
      }
      // 後回しは1回だけ（印 low_priority）。繰り返し後回しにして、ずっと処理されない状態にしない
      if (d.tier === 2 && j.last_error === "low_priority") continue;
      const next = nextRunFor(d.tier, j, now);
      if (!next) continue;
      const r = await t("shadow_jobs").update(d.tier === 2 ? { next_run_at: next, last_error: "low_priority" } : { next_run_at: next }).eq("id", j.id).eq("status", "queued");
      if (!r.error) d.tier === 0 ? out.raised++ : out.lowered++;
    }
  } catch {
    /* 優先度づけの失敗は無視する（従来の順で処理する） */
  }
  return out;
}
