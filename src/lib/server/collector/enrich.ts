import "server-only";
import { normalizeUrl, parseListing, type AdapterId } from "@/lib/collector/listing";
import { matchExistingLottery } from "@/lib/collector/crossref";
import { jstDateString } from "@/lib/datetime";
import { loadAppData } from "@/lib/server/lottery-service";
import { appendSourceUrl, bumpStats, WEB_LIST_MAX_BYTES, type CollectDeps } from "@/lib/server/collector/run";
import type { AppData } from "@/types/domain";
import { fetchRespectingRobots } from "@/lib/server/safe-fetch";

/**
 * 一覧のカード全体の文章による補完（Stage 5X）。
 * 旧版は「リンク直前の数百文字」だけを保存していたため、店舗名・商品名が欠けた候補が取得制限（t.co 等）のまま要手動確認になっていた。
 * まとめサイトの一覧を1回取得し、同じリンクのカード全体の文章を保存して、再解析待ちへ戻す（候補ごとの追加取得はしない）。
 * 一覧から消えた候補は cardChecked を記録し、同じ確認を繰り返さない。
 */
export async function enrichFromListings(deps: CollectDeps, opts: { max: number }): Promise<{ checked: number; enriched: number }> {
  const { db, householdId } = deps;
  const out = { checked: 0, enriched: 0 };
  const { data: rows } = await db
    .from("collection_candidates")
    .select("id,source_id,source_url,draft,triage,manual_state,job_state,status")
    .eq("household_id", householdId)
    .in("status", ["pending", "failed"])
    .eq("kind", "new")
    .in("job_state", ["review", "failed"])
    .limit(300);
  const need = (rows ?? []).filter((r) => {
    const q = (r.draft as { queued?: { card?: string; cardChecked?: boolean; viaList?: boolean; kind?: string; context?: string; fields?: unknown } } | null)?.queued;
    return !!q && q.kind === "web_page" && (!q.card || !q.fields) && !q.cardChecked && !!q.context && (r.triage === "auto_retry" || (r.triage === "manual" && r.manual_state === "open"));
  });
  if (need.length === 0) return out;
  const { data: sources } = await db.from("collection_sources").select("id,url,adapter,kind,enabled").eq("household_id", householdId).eq("kind", "web");
  let appData: AppData | null = null;
  const bySource = new Map<string, typeof need>();
  for (const r of need) if (r.source_id) bySource.set(r.source_id, [...(bySource.get(r.source_id) ?? []), r]);
  for (const s of sources ?? []) {
    const group = bySource.get(s.id);
    if (!group || !s.url) continue;
    const res = await (deps.fetchList ?? ((u: string) => fetchRespectingRobots(u, { maxBytes: WEB_LIST_MAX_BYTES, timeoutMs: 15_000 })))(s.url);
    if (!res.ok) continue;
    const entries = parseListing((s.adapter === "pokeso" || s.adapter === "torecabiyori" ? s.adapter : "generic") as AdapterId, res.body, res.finalUrl);
    const byUrl = new Map(entries.map((e) => [e.url, e]));
    for (const r of group.slice(0, opts.max)) {
      out.checked++;
      const prior = (r.draft as Record<string, unknown>) ?? {};
      const q = { ...((prior.queued as Record<string, unknown>) ?? {}) };
      const e = r.source_url ? byUrl.get(normalizeUrl(r.source_url) ?? r.source_url) : undefined;
      if (!e?.card) {
        await db.from("collection_candidates").update({ draft: { ...prior, queued: { ...q, cardChecked: true } } as never }).eq("id", r.id);
        continue;
      }
      // 登録済みの抽選と、店舗・商品・締切日がそろって一致するなら、AIを使わずに重複として整理する（根拠を記録）
      const hints = (q as { hints?: { deadlineIso?: string | null; deadlineDate?: string | null } }).hints;
      const dueDate = hints?.deadlineIso ? jstDateString(new Date(hints.deadlineIso)) : (hints?.deadlineDate ?? null);
      if (e.fields) {
        appData ??= await loadAppData(db, householdId);
        const m = matchExistingLottery({ store: e.fields.store, product: e.fields.product, dueDate }, appData);
        if (m) {
          const nowIso = deps.now.toISOString();
          const added = r.source_url ? await appendSourceUrl(db, m.lotteryId, r.source_url) : false;
          await db
            .from("collection_candidates")
            .update({
              status: "duplicate",
              job_state: "completed",
              lottery_id: m.lotteryId,
              triage: "auto_exclude",
              triage_reason: "登録済みの抽選と同一（店舗・商品・締切日が一致）",
              manual_state: null,
              reasons: ["登録済みの抽選と同一と判断しました", ...m.evidence, added ? "既存の抽選に情報源URLを追加しました" : "既存の抽選に同じ情報源があります"],
              draft: { ...prior, queued: { ...q, card: e.card, fields: e.fields, cardChecked: true } } as never,
              resolved_at: nowIso,
              completed_at: nowIso,
            })
            .eq("id", r.id);
          await bumpStats(db, householdId, deps.now, { duplicates: 1 });
          out.enriched++;
          continue;
        }
      }
      await db
        .from("collection_candidates")
        .update({
          job_state: "pending",
          attempts: 0,
          next_run_at: null,
          triage: null,
          manual_state: null,
          reasons: ["一覧のカード全体の文章から再解析待ち"],
          draft: { ...prior, queued: { ...q, card: e.card, ...(e.fields ? { fields: e.fields } : {}), changed: true, cardChecked: true, reason: "card_enrich", listSeenAt: deps.now.toISOString() } } as never,
        })
        .eq("id", r.id);
      out.enriched++;
    }
  }
  return out;
}
