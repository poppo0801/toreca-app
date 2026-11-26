import { createClient } from "@supabase/supabase-js";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ps = (await db.from("registration_proposals").select("candidate_id").eq("mode","real")).data ?? [];
const ids=[...new Set(ps.map(p=>p.candidate_id))];
for (const id of ids) { const js=(await db.from("shadow_jobs").select("evidence_hash,status").eq("candidate_id",id)).data??[]; console.log(id.slice(0,8), js.map(j=>`${j.evidence_hash.length}:${j.status}`).sort().join(" ")); }
const q=(await db.from("shadow_jobs").select("status").in("status",["queued","leased"])).data??[]; console.log("queued/leased", q.length);
