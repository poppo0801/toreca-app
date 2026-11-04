import "server-only";
import { normalizeUrl, parseListing, type AdapterId } from "@/lib/collector/listing";
import { WEB_LIST_MAX_BYTES, type CollectDeps } from "@/lib/server/collector/run";
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
      await db
        .from("collection_candidates")
        .update({
          job_state: "pending",
          attempts: 0,
          next_run_at: null,
          triage: null,
          manual_state: null,
          reasons: ["一覧のカード全体の文章から再解析待ち"],
          draft: { ...prior, queued: { ...q, card: e.card, ...(e.fields ? { fields: e.fields } : {}), changed: true } } as never,
        })
        .eq("id", r.id);
      out.enriched++;
    }
  }
  return out;
}
