// Stage 9V: 本番の自律探索の実績の再集計（読み取り専用。何も書き込まない）。
//   npm run prod -- scripts/analyze-discovery-9v.mjs --yes-production [--since=2026-11-19T06:00:00Z]
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("analyze-discovery-9v.mjs");
const since = (process.argv.find((a) => a.startsWith("--since=")) ?? "").slice(8) || "2026-11-19T06:00:00Z";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const runs = (await db.from("discovery_runs").select("*").gte("started_at", since).order("started_at", { ascending: true })).data ?? [];
const sum = { runs: runs.length, cost: 0, ms: 0, found: 0, registered: 0, held: 0, excluded: 0, duplicates: 0, mismatches: 0, alreadyKnown: 0 };
const missions = {};
const mismatchReasons = {};
const stops = {};
const registered = [];
for (const r of runs) {
  const c = r.counts ?? {};
  sum.cost += Number(r.cost_jpy ?? 0);
  sum.ms += Number(r.duration_ms ?? 0);
  for (const k of ["found", "registered", "held", "excluded", "duplicates", "mismatches", "alreadyKnown"]) sum[k] += Number(c[k] ?? 0);
  for (const m of r.mission_ids ?? []) missions[m] = (missions[m] ?? 0) + 1;
  stops[r.stop_reason ?? "?"] = (stops[r.stop_reason ?? "?"] ?? 0) + 1;
  for (const o of c.outcomes ?? []) {
    if (o.outcome === "registered") registered.push({ store: o.store, url: o.url, lotteryId: o.lotteryId });
    else if (o.reason) mismatchReasons[`${o.outcome}: ${String(o.reason).slice(0, 60)}`] = (mismatchReasons[`${o.outcome}: ${String(o.reason).slice(0, 60)}`] ?? 0) + 1;
  }
}
console.log(JSON.stringify({ since, sum: { ...sum, cost: Math.round(sum.cost * 100) / 100 }, distinctMissions: Object.keys(missions).length, missions, stops, outcomesNotRegistered: mismatchReasons, registered }, null, 1));
const origins = (await db.from("lottery_discovery_origins").select("lottery_id")).data ?? [];
console.log("AI由来の抽選:", origins.length);
const ids = origins.map((o) => o.lottery_id);
if (ids.length) {
  const l = (await db.from("lotteries").select("id,store_id,apply_deadline_date,archived_at,source_kind,registration_path").in("id", ids)).data ?? [];
  console.log(JSON.stringify(l.map((x) => ({ id: String(x.id).slice(0, 8), dl: x.apply_deadline_date, archived: !!x.archived_at, kind: x.source_kind, path: x.registration_path })), null, 0));
}
// 登録された抽選の中身（人が正確性を確認するための材料。個人情報は含まない）
for (const r of registered) {
  const l = (await db.from("lotteries").select("*").eq("id", r.lotteryId).maybeSingle()).data;
  const items = (await db.from("lottery_items").select("product_id,quantity,unit").eq("lottery_id", r.lotteryId)).data ?? [];
  const store = l ? (await db.from("stores").select("name,prefecture").eq("id", l.store_id).maybeSingle()).data : null;
  const prods = items.length ? (await db.from("products").select("id,official_name").in("id", items.map((i) => i.product_id))).data ?? [] : [];
  console.log(JSON.stringify({ lottery: l && Object.fromEntries(Object.entries(l).filter(([k, v]) => v !== null && !/^(household_id|created_by|updated_by)/.test(k)).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 160) : v])), store, products: prods.map((p) => p.official_name), items }, null, 1));
}
