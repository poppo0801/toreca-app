// JUDGMENT_IDENTITY_EFFICIENCY §3〜4: 本番シャドーの実効条件・再開・費用・待ち行列の確認（本番・読み取りのみ。件数・状態・理由コード・費用だけ。原文・URL・秘密は出さない）。
//   npm run prod -- scripts/jie-prod-check.mjs [--since=<ISO>] --yes-production
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("jie-prod-check.mjs");
const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8) ?? "2026-11-28T00:00:00Z";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const p = (l, v) => console.log(l, JSON.stringify(v));
const bump = (m, k, n = 1) => ((m[k] = (m[k] ?? 0) + n), m);
const st = (await db.from("shadow_settings").select("household_id,enabled,daily_budget_jpy,monthly_budget_jpy,total_budget_jpy,total_since,per_case_cap_jpy,valid_until,judge_model,judge_mode")).data ?? [];
p("設定", st.map((s) => ({ enabled: s.enabled, 日次: s.daily_budget_jpy, 月次: s.monthly_budget_jpy, 通算: s.total_budget_jpy, 通算の起点: s.total_since, 一件: s.per_case_cap_jpy, 期限: s.valid_until, 上位: s.judge_model, 方式: s.judge_mode })));
for (const s of st) {
  const all = (await db.from("shadow_judgments").select("cost_jpy,created_at,status,record").eq("household_id", s.household_id).gte("created_at", s.total_since ?? "1970-01-01").limit(5000)).data ?? [];
  const tot = all.reduce((a, x) => a + Number(x.cost_jpy ?? 0), 0);
  const jstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const today = all.filter((x) => new Date(new Date(x.created_at).getTime() + 9 * 3600e3).toISOString().slice(0, 10) === jstToday).reduce((a, x) => a + Number(x.cost_jpy ?? 0), 0);
  p("費用（通算・今日）", { 通算: Math.round(tot * 100) / 100, 今日: Math.round(today * 100) / 100, 試行: all.length });
  const recent = all.filter((x) => x.created_at >= since && x.record?.kind === "proposal_shadow");
  const byDay = {};
  for (const x of recent) bump(byDay, new Date(new Date(x.created_at).getTime() + 9 * 3600e3).toISOString().slice(0, 10), Math.round(Number(x.cost_jpy ?? 0) * 100) / 100);
  const costs = recent.map((x) => Number(x.cost_jpy ?? 0)).sort((a, b) => a - b);
  const q = (f) => (costs.length ? Math.round(costs[Math.min(costs.length - 1, Math.floor(f * costs.length))] * 100) / 100 : null);
  p(`登録案の試行（${since} 以降）`, { 件数: recent.length, 状態: recent.reduce((m, x) => bump(m, x.status), {}), 日別の費用: byDay, 中央値: q(0.5), p90: q(0.9), 最大: costs.at(-1) ?? null, 再開の記録あり: recent.filter((x) => x.record?.resumes).length, 未着手が残る: recent.filter((x) => x.record?.pendingItems?.length).length, 中断した項目あり: recent.filter((x) => x.record?.interruptedItems?.length).length });
  const diag = {};
  for (const x of recent) for (const [k, v] of Object.entries(x.record?.diagnostics ?? {})) if (/thinking|upper|identity|resume/.test(k)) bump(diag, k.slice(0, 40), Number(v));
  p("診断（思考・上位・照合）", diag);
  const img = {};
  for (const x of recent) for (const [k, v] of Object.entries(x.record?.trace?.images ?? {})) bump(img, k, Number(v) || 0);
  p("画像", img);
  const pre = recent.reduce((m, x) => bump(m, String(x.record?.trace?.prefetch ?? "-").slice(0, 30)), {});
  p("事前取得", pre);
}
const jobs = (await db.from("shadow_jobs").select("status,last_error,skip_reason,attempts,updated_at").gte("updated_at", "2026-11-26T00:00:00Z").limit(5000)).data ?? [];
p("ジョブ（11/26以降に更新）", jobs.reduce((m, j) => bump(m, `${j.status}:${j.last_error ?? j.skip_reason ?? "-"}`.slice(0, 50)), {}));
const queued = (await db.from("shadow_jobs").select("id", { count: "exact", head: true }).eq("status", "queued")).count;
p("待ちのジョブ", queued);
const props = (await db.from("registration_proposals").select("decision,verified,end_reason,prompt_version,fields,created_at").eq("mode", "real").is("superseded_at", null).gte("created_at", since).limit(3000)).data ?? [];
p("登録案（現行の版）", { 件数: props.length, 版: props.reduce((m, x) => bump(m, x.prompt_version), {}), 判断: props.reduce((m, x) => bump(m, `${x.decision}:${x.verified}`), {}), 終了: props.reduce((m, x) => bump(m, x.end_reason ?? "-"), {}), 照合: props.reduce((m, x) => bump(m, x.fields?._identity?.identity?.relation ?? "未照合"), {}) });
const docs = (await db.from("evidence_documents").select("origin,truncated,created_at").gte("created_at", since).limit(5000)).data ?? [];
p("保存した文書（由来・切り詰め）", docs.reduce((m, d) => bump(m, `${d.origin}:${d.truncated ? "切" : "全"}`), {}));
const runs = (await db.from("collection_runs").select("started_at,status,stop_reason,trigger,sources_failed,sources_total").gte("started_at", "2026-11-25T00:00:00Z").order("started_at", { ascending: false }).limit(500)).data ?? [];
p("旧方式の収集の実行（11/25以降・状態:停止理由）", runs.reduce((m, r) => bump(m, `${r.trigger}:${r.status}:${String(r.stop_reason ?? "-").slice(0, 40)}`), {}));
p("一時停止・失敗の実行（時刻）", runs.filter((r) => /pause|停止|fail|error/i.test(`${r.status}${r.stop_reason ?? ""}`)).slice(0, 12).map((r) => `${r.started_at.slice(5, 16)} ${r.status}:${String(r.stop_reason ?? "").slice(0, 40)}`));
