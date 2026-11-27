// EVIDENCE_UTILIZATION §5: 既存の自律型の発見（AUTONOMOUS_COLLECTION）の実績（読み取りのみ。原文・URL・店名は出さない。件数・費用・種類だけ）。
//   npm run prod -- scripts/eu-discovery-audit.mjs [--since=<ISO>] --yes-production
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("eu-discovery-audit.mjs");
const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8) ?? "2026-11-16T00:00:00Z";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const bump = (m, k, n = 1) => (m[k] = (m[k] ?? 0) + n);
const p = (l, v) => console.log(l, JSON.stringify(v));

const runs = (await db.from("discovery_runs").select("engine,trigger,status,stop_reason,counts,cost_jpy,duration_ms,records,mission_ids,created_at").gte("created_at", since).order("created_at")).data ?? [];
const tot = {};
const stops = {};
const kinds = {};
const outcomes = {};
let cost = 0;
let ms = 0;
for (const r of runs) {
  cost += Number(r.cost_jpy ?? 0);
  ms += Number(r.duration_ms ?? 0);
  bump(stops, `${r.status}:${r.stop_reason ?? "-"}`);
  for (const [k, v] of Object.entries(r.counts ?? {})) if (typeof v === "number") bump(tot, k, v);
  for (const rec of Array.isArray(r.records) ? r.records : []) {
    bump(kinds, `${rec.kind ?? rec.mission?.kind ?? rec.missionKind ?? "?"}`);
    for (const o of Array.isArray(rec.outcomes) ? rec.outcomes : []) bump(outcomes, String(o.outcome ?? o.status ?? "?"));
  }
}
p("実行", { 件数: runs.length, 費用円: Math.round(cost * 100) / 100, 平均秒: runs.length ? Math.round(ms / runs.length / 1000) : 0, 状態: stops });
p("件数の合計（counts）", tot);
p("記録の種類（records）", kinds);
p("記録の結果（records.outcomes）", outcomes);
if (runs[0]) {
  const r = runs.find((x) => Array.isArray(x.records) && x.records.length) ?? runs[0];
  const rec = Array.isArray(r.records) ? r.records[0] : null;
  p("記録の形（キー名のみ）", { run: Object.keys(r), counts: Object.keys(r.counts ?? {}), record: rec ? Object.keys(rec) : [] });
}
// 発見由来の抽選（lottery_discovery_origins）と、その後（人の扱い・重複）
const ori = (await db.from("lottery_discovery_origins").select("*").gte("created_at", since)).data ?? [];
p("発見由来の抽選の記録", { 件数: ori.length, 列: ori[0] ? Object.keys(ori[0]) : [] });
const lotIds = [...new Set(ori.map((o) => o.lottery_id).filter(Boolean))];
if (lotIds.length) {
  const lots = (await db.from("lotteries").select("id,archived_at,source_kind,created_at,chain_id,store_id").in("id", lotIds)).data ?? [];
  const lk = {};
  for (const l of lots) bump(lk, `${l.source_kind ?? "?"}${l.archived_at ? ":アーカイブ" : ""}`);
  p("発見由来の抽選の状態", { 抽選: lots.length, 内訳: lk, 系列数: new Set(lots.map((l) => l.chain_id).filter(Boolean)).size });
  // 既存の情報源（収集の候補）と重なるか: 同じ抽選に収集の候補が結び付いているか
  const cands = (await db.from("collection_candidates").select("lottery_id").in("lottery_id", lotIds)).data ?? [];
  const withCand = new Set(cands.map((c) => c.lottery_id));
  p("発見由来の抽選のうち、通常の収集の候補にも現れたもの", { 重なり: lotIds.filter((id) => withCand.has(id)).length, 発見だけ: lotIds.filter((id) => !withCand.has(id)).length });
}
const strat = await db.from("discovery_strategy").select("*", { count: "exact", head: true });
p("探索実績（discovery_strategy）の行数", strat.error ? `読めない ${strat.error.message.slice(0, 60)}` : strat.count);
