import { createClient } from "@supabase/supabase-js";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8) ?? "2026-11-26T00:00:00Z";
const ids = ["6e8dfc36", "eec5c3dd", "bf982aae"];
const cands = (await db.from("collection_candidates").select("id").limit(2000)).data ?? [];
const props = (await db.from("registration_proposals").select("*").eq("mode", "real").gte("created_at", since).order("created_at")).data ?? [];
for (const p of props) {
  const tag = ids.find((i) => p.candidate_id.startsWith(i)) ?? p.candidate_id.slice(0, 8);
  const f = p.fields ?? {};
  console.log(JSON.stringify({ case: tag, v: p.version, decision: p.decision, verified: p.verified, unit: `${p.apply_unit}/${p.apply_unit_basis}`, yen: Number(p.cost_jpy), turns: p.turns, model: p.model_id, prompt: p.prompt_version, end: p.end_reason, stop: p.stop_reason, held: p.held_reasons, fields: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v?.basis])), at: p.created_at }));
}
const js = (await db.from("shadow_judgments").select("status,cost_jpy,record,created_at,candidate_id").gte("created_at", since).order("created_at")).data ?? [];
for (const j of js) {
  const tag = ids.find((i) => j.candidate_id.startsWith(i)) ?? j.candidate_id.slice(0, 8);
  console.log("JUDG", JSON.stringify({ case: tag, status: j.status, yen: Number(j.cost_jpy), tools: j.record?.trace?.tools, prefetch: j.record?.trace?.prefetch, fetches: j.record?.trace?.fetches, end: j.record?.trace?.endReasons, diag: j.record?.diagnostics }));
}
const sp = await db.rpc("shadow_spent", { p_household: (await db.from("households").select("id")).data[0].id, p_since: "2026-11-25T04:45:02Z" });
console.log("通算", sp.data);
