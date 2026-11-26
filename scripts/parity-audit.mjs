// PRODUCTION_PARITY §1: 本番の実稼働の横断監査（読み取りのみ。値・秘密・原文・URLは出さない。件数・状態・理由コードだけ）。
//   npm run prod -- scripts/parity-audit.mjs [--days=7] --yes-production
// 収集の実行（cron/手動・段階・結果）・情報源の種類別の最終成功・X収集の利用状況・cronの呼び出し・保存表の件数（全文・再調査・画像・ホスト制御・計測・経験）を出す。
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("parity-audit.mjs");
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 7);
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const bump = (m, k, n = 1) => (m[k] = (m[k] ?? 0) + n);
async function all(q, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const r = await q().range(from, from + page - 1);
    if (r.error) return out;
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < page) break;
  }
  return out;
}
const p = (label, v) => console.log(label, typeof v === "string" ? v : JSON.stringify(v));

// 1) 収集の実行
const runs = await all(() => db.from("collection_runs").select("*").gte("started_at", since).order("started_at"));
const byDay = {};
for (const r of runs) {
  const d = (byDay[String(r.started_at).slice(0, 10)] ??= { runs: 0, phases: {}, results: {}, web_fetched: 0, x_posts: 0, x_calls: 0, ai_calls: 0, new: 0, registered: 0, errors: 0, sources_total: 0, sources_failed: 0 });
  d.runs++;
  bump(d.phases, `${r.trigger}:${r.phase ?? "?"}`);
  bump(d.results, `${r.status}:${r.result ?? "-"}`);
  d.web_fetched += r.web_fetched ?? 0;
  d.x_posts += r.x_posts ?? 0;
  d.x_calls += r.x_calls ?? 0;
  d.ai_calls += r.ai_calls ?? 0;
  d.new += r.new_count ?? 0;
  d.registered += r.registered_count ?? 0;
  d.errors += r.error_count ?? 0;
  d.sources_total += r.sources_total ?? 0;
  d.sources_failed += r.sources_failed ?? 0;
}
p("収集の実行（日別）", byDay);
const sumKinds = {};
for (const r of runs) for (const s of Array.isArray(r.summary) ? r.summary : []) bump(sumKinds, `${s.kind ?? s.type ?? "?"}:${s.status ?? s.result ?? s.ok ?? "?"}`);
p("実行の要約の種類", sumKinds);
p("実行の列（名前のみ）", runs[0] ? Object.keys(runs[0]) : []);

// 2) 情報源
const srcs = (await db.from("collection_sources").select("*")).data ?? [];
const sk = {};
for (const s of srcs) {
  const k = `${s.kind ?? s.source_type ?? "?"}:${s.enabled === false ? "off" : "on"}`;
  const x = (sk[k] ??= { n: 0, lastOk: null, lastErr: 0 });
  x.n++;
  const t = s.last_success_at ?? s.last_ok_at ?? s.last_fetched_at ?? null;
  if (t && (!x.lastOk || t > x.lastOk)) x.lastOk = t;
  if (s.last_error) x.lastErr++;
}
p("情報源（種類:有効）", sk);
p("情報源の列（名前のみ）", srcs[0] ? Object.keys(srcs[0]) : []);

// 3) 収集設定（値ではなく、X関連・自律型・方式の有無だけ）
const set = (await db.from("collection_settings").select("*")).data ?? [];
for (const s of set) p("収集設定（キーと型）", Object.fromEntries(Object.entries(s).filter(([k]) => !/id$|token|secret|key/i.test(k)).map(([k, v]) => [k, v === null ? null : typeof v === "boolean" || typeof v === "number" ? v : Array.isArray(v) ? `array(${v.length})` : typeof v === "string" ? (v.length <= 24 && !/https?:/.test(v) ? v : `str(${v.length})`) : typeof v])));

// 4) cron の呼び出し（job別・日別・状態）
const calls = await all(() => db.from("notification_cron_calls").select("job,called_at,status_code,error_msg").gte("called_at", since).order("called_at"));
const cj = {};
for (const c of calls) bump((cj[c.job] ??= {}), `${String(c.called_at).slice(0, 10)}:${c.status_code ?? "null"}${c.error_msg ? ":err" : ""}`);
p("cronの呼び出し", cj);

// 5) 保存表の件数（全期間と期間内）
for (const [tbl, col] of [["evidence_documents", "created_at"], ["evidence_coverage_stats", "created_at"], ["link_recheck_tasks", "created_at"], ["fetch_gate_hosts", "updated_at"], ["research_experiences", "created_at"], ["image_observations", "created_at"], ["shadow_judgments", "created_at"], ["shadow_jobs", "created_at"], ["registration_proposals", "created_at"]]) {
  const a = await db.from(tbl).select("*", { count: "exact", head: true });
  const b = await db.from(tbl).select("*", { count: "exact", head: true }).gte(col, since);
  p(`表 ${tbl}`, a.error ? `読めない: ${a.error.message.slice(0, 80)}` : { 全期間: a.count, 期間内: b.count });
}
const docs = (await db.from("evidence_documents").select("kind,origin,created_at").gte("created_at", since)).data ?? [];
const dk = {};
for (const d of docs) bump(dk, `${d.kind}:${d.origin}`);
p("全文の保存（期間内・由来別）", dk);

// 6) X 収集の痕跡（候補の作成日 × X投稿か）
const xc = await all(() => db.from("collection_candidates").select("created_at,x_post_id,status").gte("created_at", since).order("created_at"));
const xd = {};
for (const c of xc) bump((xd[String(c.created_at).slice(0, 10)] ??= {}), c.x_post_id ? "x" : "web");
p("候補の作成（日別・X/Web）", xd);
const tok = await db.from("x_oauth_tokens").select("*", { count: "exact", head: true });
p("Xの連携トークンの行数", tok.error ? "読めない" : tok.count);
const bm = (await db.from("x_bookmark_posts").select("created_at").gte("created_at", since)).data ?? [];
const bd = {};
for (const b of bm) bump(bd, String(b.created_at).slice(0, 10));
p("ブックマーク取り込み（日別）", bd);

// 7) シャドーのジョブ: 候補ごとの回数・投入の理由（同じ候補の再評価の頻度＝予算の浪費の有無）
const sj = await all(() => db.from("shadow_jobs").select("*").order("created_at"));
p("シャドーのジョブの列（名前のみ）", sj[0] ? Object.keys(sj[0]) : []);
const perC = {};
for (const j of sj) (perC[j.candidate_id] ??= []).push(j);
const dist = {};
for (const xs of Object.values(perC)) bump(dist, String(xs.length));
p("候補あたりのジョブ数の分布（ジョブ数:候補数）", dist);
const st = {};
for (const j of sj) bump(st, `${j.status}:${(j.last_error ?? j.reason ?? "").toString().slice(0, 30)}`);
p("ジョブの状態:理由", st);
const sjd = await all(() => db.from("shadow_judgments").select("candidate_id,cost_jpy,status,record,created_at").order("created_at"));
const costPerC = {};
for (const r of sjd) costPerC[r.candidate_id] = (costPerC[r.candidate_id] ?? 0) + Number(r.cost_jpy ?? 0);
const top = Object.entries(costPerC).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ c: k.slice(0, 8), yen: Math.round(v * 100) / 100, runs: sjd.filter((x) => x.candidate_id === k).length }));
p("費用の多い候補（短縮ID・合計円・実行回数）", top);
p("実行の総額・件数", { yen: Math.round(sjd.reduce((s, r) => s + Number(r.cost_jpy ?? 0), 0) * 100) / 100, n: sjd.length, candidates: Object.keys(costPerC).length });
for (const [cid, xs] of Object.entries(perC).filter(([, xs]) => xs.length >= 4)) p("再評価の多い候補", { c: cid.slice(0, 8), jobs: xs.length, hashes: new Set(xs.map((x) => x.evidence_hash)).size, first: xs[0].created_at, last: xs[xs.length - 1].created_at, skip: [...new Set(xs.map((x) => x.skip_reason).filter(Boolean))] });

// 8) 自律型の発見（AUTONOMOUS_COLLECTION）・再評価AI の実稼働の痕跡
const dr = await all(() => db.from("discovery_runs").select("*").gte("created_at", since).order("created_at"));
p("発見の実行の列（名前のみ）", dr[0] ? Object.keys(dr[0]) : []);
const drs = {};
for (const r of dr) bump(drs, `${String(r.created_at).slice(0, 10)}:${r.status ?? r.result ?? "?"}:${r.engine ?? r.mode ?? ""}`);
p("発見の実行（日別・状態）", drs);
p("発見の費用合計（円）", Math.round(dr.reduce((s, r) => s + Number(r.cost_jpy ?? r.spent_jpy ?? 0), 0) * 100) / 100);
const ldo = await db.from("lottery_discovery_origins").select("*", { count: "exact", head: true }).gte("created_at", since);
p("発見由来の抽選（期間内）", ldo.error ? `読めない: ${ldo.error.message.slice(0, 60)}` : ldo.count);
