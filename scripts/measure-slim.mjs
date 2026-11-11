// 自動収集の候補一覧: 草稿の絞り込み前後のブラウザ向け転送量（読み取り専用。Stage 7R）
import { createClient } from "@supabase/supabase-js";
try { process.loadEnvFile(".env.local"); } catch { /* */ }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const KEEP = ["update", "provisional", "secondary", "notices", "evidence", "flags", "summary", "modePending", "warnings", "ready", "verdict", "input", "queued"];
const cols = "id,source_id,title,source_url,status,reasons,draft,lottery_id,fetched_at,job_state,kind,attempts,next_run_at,last_error,due_at,last_changed_at,memo_id";
const c = () => db.from("collection_candidates").select(cols).order("created_at", { ascending: false }).limit(100);
const rs = await Promise.all([c().eq("job_state", "review"), c().in("job_state", ["pending", "retry", "processing"]), c().eq("status", "auto_registered"), c().eq("job_state", "skipped"), c().eq("status", "duplicate"), c().eq("job_state", "failed")]);
const rows = rs.flatMap((r) => r.data ?? []);
const slim = rows.map((r) => ({ ...r, draft: r.draft ? Object.fromEntries(KEEP.filter((k) => k in r.draft).map((k) => [k, r.draft[k]])) : r.draft }));
console.log(`候補${rows.length}件 絞り込み前=${JSON.stringify(rows).length}B 後=${JSON.stringify(slim).length}B`);
