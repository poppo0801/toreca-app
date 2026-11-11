// 自動収集ページの主要クエリの転送量・時間（読み取り専用。Stage 7R）
import { createClient } from "@supabase/supabase-js";
try { process.loadEnvFile(".env.local"); } catch { /* */ }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const cols = "id,source_id,title,source_url,status,reasons,draft,lottery_id,fetched_at,job_state,kind,attempts,next_run_at,last_error,due_at,last_changed_at,memo_id";
const colsNoDraft = cols.replace("draft,", "");
const cand = (c = cols) => db.from("collection_candidates").select(c).order("created_at", { ascending: false }).limit(100);
const since = new Date(Date.now() - 30 * 86400e3).toISOString();
const qs = {
  "cand review (draft有)": () => cand().eq("job_state", "review"),
  "cand queued": () => cand().in("job_state", ["pending", "retry", "processing"]),
  "cand registered": () => cand().eq("status", "auto_registered"),
  "cand skipped": () => cand().eq("job_state", "skipped"),
  "cand duplicate": () => cand().eq("status", "duplicate"),
  "cand failed": () => cand().eq("job_state", "failed"),
  "cand registered (draft無)": () => cand(colsNoDraft).eq("status", "auto_registered"),
  "exRows 3000 (draft有)": () => db.from("collection_candidates").select("id,status,reasons,resolved_at,draft").in("status", ["excluded", "duplicate"]).limit(3000),
  "exRows (draft無)": () => db.from("collection_candidates").select("id,status,reasons,resolved_at").in("status", ["excluded", "duplicate"]).limit(3000),
  "exRows draft.input有の id": () => db.from("collection_candidates").select("id").in("status", ["excluded", "duplicate"]).not("draft->input", "is", null).limit(3000),
  "metricRows": () => db.from("collection_candidates").select("status,job_state,created_at,completed_at,due_at,fail_kind,cost_jpy,ai_calls").gte("created_at", since).limit(3000),
  "collection_sources *": () => db.from("collection_sources").select("*"),
  "collection_runs 10": () => db.from("collection_runs").select("*").order("started_at", { ascending: false }).limit(10),
};
for (const [k, f] of Object.entries(qs)) {
  const t0 = performance.now(); const { data, error } = await f(); const ms = Math.round(performance.now() - t0);
  console.log(`${k.padEnd(28)} rows=${data?.length ?? "ERR " + error?.message} bytes=${data ? JSON.stringify(data).length : 0} ${ms}ms`);
}
