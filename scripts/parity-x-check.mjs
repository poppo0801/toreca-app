// PRODUCTION_PARITY §1: X収集の停止の調査（読み取りのみ。トークン・秘密・URLは出さない。エラー文は分類のため先頭だけ、数字・英字以外を伏せずに短く）。
//   npm run prod -- scripts/parity-x-check.mjs --yes-production
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("parity-x-check.mjs");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const scrub = (s) => (s == null ? null : String(s).replace(/https?:\/\/\S+/g, "<url>").replace(/[A-Za-z0-9_-]{24,}/g, "<tok>").slice(0, 160));
const srcs = (await db.from("collection_sources").select("kind,adapter,enabled,status,error_message,last_attempt_at,last_success_at,last_result,consecutive_failures,last_item_count,interval_hours")).data ?? [];
for (const s of srcs) console.log("情報源", JSON.stringify({ ...s, error_message: scrub(s.error_message), last_result: typeof s.last_result === "string" ? scrub(s.last_result) : s.last_result }));
const runs = (await db.from("collection_runs").select("started_at,phase,result,stop_reason,error_count,x_calls,x_posts,summary").gte("started_at", "2026-11-22T18:00:00Z").lte("started_at", "2026-11-23T03:00:00Z").neq("phase", "worker").order("started_at")).data ?? [];
for (const r of runs) console.log("実行", JSON.stringify({ at: r.started_at, phase: r.phase, result: r.result, stop: scrub(r.stop_reason), err: r.error_count, x_calls: r.x_calls, x_posts: r.x_posts, summary: (Array.isArray(r.summary) ? r.summary : []).slice(0, 6).map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === "string" ? scrub(v) : v]))) }));
const last = (await db.from("collection_runs").select("started_at,phase,result,stop_reason,error_count,x_calls,x_posts,summary").neq("phase", "worker").order("started_at", { ascending: false }).limit(6)).data ?? [];
for (const r of last) console.log("直近", JSON.stringify({ at: r.started_at, phase: r.phase, result: r.result, stop: scrub(r.stop_reason), err: r.error_count, x_calls: r.x_calls, x_posts: r.x_posts, summary: (Array.isArray(r.summary) ? r.summary : []).slice(0, 6).map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === "string" ? scrub(v) : v]))) }));
const tok = (await db.from("x_oauth_tokens").select("*")).data ?? [];
for (const t of tok) console.log("連携トークン", JSON.stringify(Object.fromEntries(Object.entries(t).filter(([k]) => /(_at|status|scope|error|expires|revoked|updated|created)/i.test(k) && !/token$/i.test(k)).map(([k, v]) => [k, typeof v === "string" && v.length > 40 ? `str(${v.length})` : v]))));
