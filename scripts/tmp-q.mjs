import { createClient } from "@supabase/supabase-js";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const hid=(await db.from("households").select("id")).data[0].id;
console.log("JST今日", (await db.rpc("shadow_spent",{p_household:hid,p_since:"2026-11-25T15:00:00Z"})).data, "通算", (await db.rpc("shadow_spent",{p_household:hid,p_since:"2026-11-25T04:45:02Z"})).data);
const p=(await db.from("registration_proposals").select("quote_audit,held_reasons,decision,fields").eq("candidate_id", (await db.from("collection_candidates").select("id").like("id","bf982aae%")).data?.[0]?.id ?? "x").order("created_at",{ascending:false}).limit(1)).data;
console.log(JSON.stringify(p?.[0]?.held_reasons), p?.[0]?.decision);
