import "server-only";
import { hashNormalized } from "@/lib/collector/queue";
import { decideHold, needsImageRetry, triagePatch } from "@/lib/collector/triage";
import { extractPageText } from "@/lib/ai/page-text";
import { fetchRespectingRobots } from "@/lib/server/safe-fetch";
import { runReevaluation } from "@/lib/server/collector/reevaluate";
import { bumpStats, type CollectDeps } from "@/lib/server/collector/run";

/**
 * 保留（自動再調査）の実行（Stage 5T）。ワーカーの各回で、次回調査の時刻を過ぎた候補だけを再調査する。朝6時の収集を待たない。
 *  1) 無料の再調査: 保存済みの解析結果を、現在のマスター・別名辞書・収集条件で照合し直す（登録・重複・除外・対象外の判定。AIは呼ばない）
 *  2) 取得元の再確認（無料）: 告知ページの本文が変わっていれば、再解析待ち（月額予算の範囲）に戻す。変わっていなければAIを呼ばない（同じ入力の再解析をしない）
 *  3) まだ解決しない候補は、締切・回数から「保留を続ける」か「要手動確認」かを判定する。回数・間隔は内部で管理し、設定画面には出さない
 */
export async function runHoldPass(deps: CollectDeps, opts: { max: number; timeLeft: () => number }): Promise<{ checked: number; resolved: number; held: number; manual: number; reanalyze: number }> {
  const { db, householdId, now } = deps;
  const out = { checked: 0, resolved: 0, held: 0, manual: 0, reanalyze: 0 };
  const nowIso = now.toISOString();
  const base = () => db.from("collection_candidates").select("id,source_url,dedupe_key,reasons,due_at,hold_count,page_hash,draft,last_checked_at,triage,ai_calls,x_post_id").eq("household_id", householdId).eq("job_state", "review").eq("status", "pending").eq("kind", "new");
  const [due, legacy] = await Promise.all([base().eq("triage", "auto_retry").lte("next_run_at", nowIso).order("due_at", { ascending: true, nullsFirst: false }).limit(opts.max), base().is("triage", null).limit(Math.max(0, Math.floor(opts.max / 2)))]);
  const rows = [...(due.data ?? []), ...(legacy.data ?? [])];
  if (rows.length === 0) return out;
  out.checked = rows.length;
  const ids = rows.map((r) => r.id);

  // 1) 無料の再調査（AIなし）
  await runReevaluation(deps, { execute: true, aiMax: 0, ids, budgetMs: Math.max(8_000, opts.timeLeft() - 4_000) }).catch(() => undefined);

  // 1b) X投稿の添付画像を取得し直して再解析（画像が未取得だったものだけ、少数。X API・AIは月額予算の範囲内）
  const imgIds = rows
    .filter((r) => needsImageRetry({ isX: !!r.x_post_id || r.dedupe_key.startsWith("x:"), aiCalls: r.ai_calls ?? 0, holdCount: r.hold_count ?? 0, texts: [...(r.reasons ?? []), ...(((r.draft as { notices?: string[] } | null)?.notices) ?? [])] }))
    .slice(0, 2)
    .map((r) => r.id);
  if (imgIds.length > 0 && opts.timeLeft() > 20_000) await runReevaluation(deps, { execute: true, aiMax: imgIds.length, classes: ["C"], ids: imgIds, budgetMs: Math.max(10_000, opts.timeLeft() - 4_000) }).catch(() => undefined);

  // 2) 取得元の再確認（無料）。本文が変わったときだけ再解析待ちへ
  const still = (await db.from("collection_candidates").select("id,source_url,dedupe_key,reasons,due_at,hold_count,page_hash,draft,triage,job_state,status").in("id", ids)).data ?? [];
  out.resolved = still.filter((r) => r.job_state !== "review" || r.status !== "pending").length;
  for (const c of still) {
    if (c.job_state !== "review" || c.status !== "pending") continue;
    let reanalyze = false;
    const patch: Record<string, unknown> = { last_checked_at: nowIso };
    if (c.source_url && !c.dedupe_key.startsWith("x:") && opts.timeLeft() > 10_000) {
      const pg = await (deps.fetchPage ?? ((u: string) => fetchRespectingRobots(u)))(c.source_url);
      if (pg.ok) {
        const text = extractPageText(pg.body, pg.finalUrl).text;
        if (text.length >= 30) {
          const hash = hashNormalized(text);
          // 前回の解析時の本文と異なる場合だけ、再解析する（初回は基準を記録するだけ）
          reanalyze = !!c.page_hash && c.page_hash !== hash;
          patch.page_hash = hash;
        }
      }
    }
    if (reanalyze) {
      const prior = (c.draft as Record<string, unknown> | null) ?? {};
      const q = { ...((prior.queued as object | undefined) ?? { kind: "web_page", url: c.source_url ?? "", title: "", context: "", sourceName: "再調査", attempts: 0 }), changed: true };
      await db.from("collection_candidates").update({ ...patch, job_state: "pending", attempts: 0, next_run_at: null, reasons: ["再調査: 告知ページの内容が変わったため、再解析待ち"], draft: { ...prior, queued: q } as never }).eq("id", c.id);
      out.reanalyze++;
      continue;
    }
    // 3) 保留を続けるか、要手動確認か
    const hd = decideHold({ now, dueAt: c.due_at ? new Date(c.due_at) : null, gaps: (c.reasons ?? []).slice(0, 8), holdCount: c.hold_count ?? 0, failKind: null, altTried: false, important: false });
    if (hd.triage === "auto_exclude") {
      await db.from("collection_candidates").update({ ...patch, status: "excluded", job_state: "skipped", fail_kind: "expired", reasons: [hd.reason], resolved_at: nowIso, completed_at: nowIso, ...triagePatch(hd, c, now) }).eq("id", c.id);
      await bumpStats(db, householdId, now, { excluded: 1 });
      out.resolved++;
    } else {
      await db.from("collection_candidates").update(({ ...patch, ...triagePatch(hd, c, now) }) as never).eq("id", c.id);
      if (hd.triage === "manual") out.manual++;
      else out.held++;
    }
  }
  return out;
}
