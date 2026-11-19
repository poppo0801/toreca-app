// Stage 9U: 本番の自律探索の実績の集計（読み取り専用。何も書き込まない）。
//   npm run prod -- scripts/analyze-discovery-9u.mjs --yes-production
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("analyze-discovery-9u.mjs");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const runs = await db.from("discovery_runs").select("*").order("started_at", { ascending: false }).limit(50);
if (runs.error) throw new Error(runs.error.message);
console.log(`discovery_runs: ${runs.data.length}件`);
console.log("列:", Object.keys(runs.data[0] ?? {}).join(","));
for (const r of runs.data.slice(0, 12)) {
  console.log(JSON.stringify({ counts: r.counts, missions: r.mission_ids, recs: (r.records ?? []).map((x) => ({ trig: x.trigger, c: x.counts, stop: x.stop, fu: (x.followUps ?? []).length, q: x.searchQueries, uc: x.unconfirmed, leads: (x.leads ?? []).map((l) => [l.lead.chain, l.lead.store, l.decision.status, l.decision.exclusion, l.decision.credit]) })) }).slice(0, 1500));
  const rec = r.record ?? r.summary ?? {};
  console.log(JSON.stringify({ at: r.started_at, cost: r.cost_jpy, ms: r.duration_ms, stop: r.stop_reason, trigger: rec.trigger ?? r.trigger, counts: rec.counts, unconfirmed: (rec.unconfirmed ?? []).slice(0, 3), focus: (rec.focus ?? []).map((f) => f.target).slice(0, 3), searches: (rec.searchQueries ?? []).length, sources: (rec.sources ?? []).length, failed: (rec.sources ?? []).filter((s) => !s.ok).map((s) => s.host).slice(0, 5) }));
}
const origins = await db.from("lottery_discovery_origins").select("lottery_id", { count: "exact", head: true });
console.log("AI由来の抽選（lottery_discovery_origins）:", origins.count);
const lots = await db.from("lotteries").select("source_kind,registration_path", { count: "exact" }).is("archived_at", null).limit(1000);
const by = {};
for (const l of lots.data ?? []) by[`${l.source_kind}/${l.registration_path}`] = (by[`${l.source_kind}/${l.registration_path}`] ?? 0) + 1;
console.log("抽選の出どころ:", JSON.stringify(by));
