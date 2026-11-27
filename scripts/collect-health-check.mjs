// AUTONOMY_RESTORATION §1: 収集の稼働状況（読み取りのみ。件数・状態・理由コードだけ。原文・秘密は出さない）
//   npm run prod -- scripts/collect-health-check.mjs [--hours=24] --yes-production
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("collect-health-check.mjs");
const hours = Number(process.argv.find((a) => a.startsWith("--hours="))?.slice(8) ?? 24);
const since = new Date(Date.now() - hours * 3600_000).toISOString();
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const p = (l, v) => console.log(l, JSON.stringify(v));
const cands = (await db.from("collection_candidates").select("created_at,x_post_id").gte("created_at", since).limit(2000)).data ?? [];
const byHour = {};
for (const c of cands) {
  const h = c.created_at.slice(0, 13);
  byHour[h] = (byHour[h] ?? 0) + 1;
}
p("候補の作成（時間別・UTC）", byHour);
p("候補の内訳", { X: cands.filter((c) => c.x_post_id).length, Web: cands.filter((c) => !c.x_post_id).length });
for (const t of ["collection_runs", "collector_runs", "x_sync_runs"]) {
  const r = await db.from(t).select("*").gte("started_at", since).order("started_at", { ascending: false }).limit(200);
  if (r.error) {
    p(`${t}`, { error: r.error.message.slice(0, 60) });
    continue;
  }
  const rows = r.data ?? [];
  const st = {};
  for (const x of rows) {
    const k = `${x.source ?? x.kind ?? x.engine ?? "-"}:${x.status ?? "-"}:${String(x.error ?? x.stop_reason ?? "").slice(0, 40)}`;
    st[k] = (st[k] ?? 0) + 1;
  }
  p(`${t}（${hours}時間）`, { 件数: rows.length, 最新: rows[0]?.started_at ?? null, 状態: st });
}
const calls = (await db.from("cron_calls").select("path,called_at,status_code").gte("called_at", since).limit(3000)).data;
if (calls) {
  const by = {};
  for (const c of calls) by[`${c.path}:${c.status_code}`] = (by[`${c.path}:${c.status_code}`] ?? 0) + 1;
  p("cronの呼び出し", by);
}
const paused = (await db.from("collection_runs").select("started_at,finished_at,status,error").gte("started_at", since).ilike("error", "%一時停止%").order("started_at", { ascending: false }).limit(10)).data ?? [];
p("自動処理の一時停止（時刻）", paused.map((x) => x.started_at));
const lastNew = (await db.from("collection_candidates").select("created_at").order("created_at", { ascending: false }).limit(1)).data?.[0]?.created_at ?? null;
p("最後に作られた候補", lastNew);
