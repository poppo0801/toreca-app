import { createClient } from "@supabase/supabase-js";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const props = (await db.from("registration_proposals").select("candidate_id,version,decision,fields,unknowns,pages,source_urls,url_status").eq("mode", "real").gte("created_at", "2026-11-25T23:59:30Z").order("created_at")).data ?? [];
for (const p of props) {
  console.log(p.candidate_id.slice(0, 8), "v" + p.version, p.decision, "url:", p.url_status, "pages:", JSON.stringify((p.pages ?? []).map((x) => ({ host: x.host, scope: x.scope, slots: x.slots, chars: x.chars }))));
  console.log("  rationale:", String(p.fields?._rationale?.value ?? "").slice(0, 400));
  console.log("  unknowns:", JSON.stringify((p.unknowns ?? []).map((u) => u.what + ":" + String(u.why).slice(0, 80))).slice(0, 500));
}
