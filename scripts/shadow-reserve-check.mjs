// CAPABILITY_CEILING: シャドーの「未確定費用の引当」（worker.ts unconfirmedReserveJpy と同じ数え方）の内訳（読み取りのみ。件数・状態・理由コードだけ）
//   npm run prod -- scripts/shadow-reserve-check.mjs --yes-production
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("shadow-reserve-check.mjs");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const jobs = (await db.from("shadow_jobs").select("id,attempts,status,skip_reason,last_error,lease_until,updated_at").gt("attempts", 0).in("status", ["queued", "leased", "failed", "done"]).limit(500)).data ?? [];
const rec = (await db.from("shadow_judgments").select("job_id").not("job_id", "is", null).limit(2000)).data ?? [];
const recorded = new Map();
for (const r of rec) recorded.set(r.job_id, (recorded.get(r.job_id) ?? 0) + 1);
let n = 0;
const by = {};
const day = {};
for (const j of jobs) {
  if (j.status === "leased" && j.lease_until && new Date(j.lease_until).getTime() > Date.now()) continue;
  const k = Math.max(0, j.attempts - (recorded.get(j.id) ?? 0));
  if (!k) continue;
  n += k;
  const key = `${j.status}:${(j.last_error ?? j.skip_reason ?? "-").slice(0, 24)}`;
  by[key] = (by[key] ?? 0) + k;
  const d = new Date(new Date(j.updated_at).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  day[d] = (day[d] ?? 0) + k;
}
const st = (await db.from("shadow_settings").select("per_case_cap_jpy,daily_budget_jpy").limit(1).maybeSingle()).data;
console.log("未確定の試行", n, "引当（円）", Math.round(n * Number(st?.per_case_cap_jpy ?? 0) * 100) / 100, "日次上限", st?.daily_budget_jpy);
console.log("内訳（状態:最後の理由）", JSON.stringify(by));
console.log("最終更新日（日本時間）別", JSON.stringify(day));
