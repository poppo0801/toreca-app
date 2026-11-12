// 実データ評価（Stage 8F-2）の材料の件数だけを数える（読み取り専用・件数のみ出力）。
//   npm run prod -- scripts/count-grouping-sources.mjs --yes-production
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const all = async (table, cols, f = (q) => q) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(table).select(cols)).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
};
const tally = (rows, f) => rows.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
const lots = await all("lotteries", "id,chain_id,bulk_group_id,archived_at,source_urls,apply_deadline_date,created_at");
const live = lots.filter((l) => !l.archived_at);
const groupsAll = await all("lottery_bulk_groups", "id,origin,dissolved_at");
const events = await all("lottery_group_events", "action,origin,detail");
const cands = await all("collection_candidates", "lottery_id");
const perChain = tally(live, (l) => l.chain_id);
const memberCount = tally(live.filter((l) => l.bulk_group_id), (l) => l.bulk_group_id);
console.log(JSON.stringify({
  lotteries: { total: lots.length, live: live.length, withSourceUrl: live.filter((l) => (l.source_urls ?? []).length > 0).length, inGroup: live.filter((l) => l.bulk_group_id).length },
  groups: { byOrigin: tally(groupsAll.filter((g) => !g.dissolved_at), (g) => g.origin), dissolved: groupsAll.filter((g) => g.dissolved_at).length, sizes: tally(Object.values(memberCount), (n) => String(n)) },
  events: { byActionOrigin: tally(events, (e) => `${e.action}/${e.origin}`), manualRemovedWithWasWith: events.filter((e) => e.action === "removed" && e.origin === "manual" && Array.isArray(e.detail?.wasWith) && e.detail.reason !== "group_too_small").length },
  chains: { withTwoOrMoreLiveLotteries: Object.values(perChain).filter((n) => n >= 2).length, largest: Object.values(perChain).sort((a, b) => b - a).slice(0, 5) },
  candidatesLinkedToLottery: cands.filter((c) => c.lottery_id).length,
}, null, 2));
