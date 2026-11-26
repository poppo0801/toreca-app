// PRODUCTION_PARITY 本番反映後の確認（読み取りのみ。原文・URL・値は出さない。件数・字数・状態だけ）。
//   npm run prod -- scripts/parity-prod-check.mjs --since=<ISO> --yes-production
// 収集由来の全文の保存（origin=collector*）・候補の証拠（取得したページ本文・画像の参照）・新AIの登録案（取得元の扱い・版・読み戻し）・再評価の間隔・ブックマーク同期の再試行間隔を、指定時刻以降で数える。
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("parity-prod-check.mjs");
const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8);
if (!since) {
  console.error("--since=<ISO> が必要です（本番反映の時刻）");
  process.exit(2);
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const bump = (m, k, n = 1) => (m[k] = (m[k] ?? 0) + n);
const p = (l, v) => console.log(l, JSON.stringify(v));

const docs = (await db.from("evidence_documents").select("candidate_id,kind,origin,text_chars,source_chars,truncated,truncated_reason,created_at").gte("created_at", since).limit(2000)).data ?? [];
const dk = {};
for (const d of docs) bump(dk, `${d.kind}:${d.origin}${d.truncated ? `:切詰(${d.truncated_reason})` : ""}`);
const chars = docs.filter((d) => d.origin.startsWith("collector")).map((d) => d.text_chars).sort((a, b) => a - b);
p("全文の保存（由来別）", dk);
p("収集由来の全文の字数", chars.length ? { n: chars.length, min: chars[0], median: chars[Math.floor(chars.length / 2)], max: chars[chars.length - 1] } : { n: 0 });

const cands = (await db.from("collection_candidates").select("id,status,job_state,x_post_id,last_good,last_checked_at").gte("last_checked_at", since).limit(2000)).data ?? [];
const ck = {};
for (const c of cands) {
  const ev = c.last_good?.evidence;
  if (!ev?.v) {
    bump(ck, "証拠なし");
    continue;
  }
  bump(ck, `${ev.via}/${ev.textSource ?? "?"}`);
  if ((ev.imageCount ?? 0) > 0) bump(ck, (ev.imageRefs ?? []).length ? "画像の参照あり" : "画像の参照なし");
  if ((ev.linkLedger ?? []).length) bump(ck, "リンク台帳あり");
}
p("確認された候補の証拠（原文の種類）", { 候補: cands.length, ...ck });
const withDoc = new Set(docs.map((d) => d.candidate_id));
p("Web候補のうち全文の保存あり", { web: cands.filter((c) => !c.x_post_id && c.last_good?.evidence?.v).length, 保存あり: cands.filter((c) => !c.x_post_id && withDoc.has(c.id)).length });

const props = (await db.from("registration_proposals").select("candidate_id,url_status,decision,verified,prompt_version,pages,created_at").eq("mode", "real").gte("created_at", since)).data ?? [];
const pk = {};
for (const x of props) {
  bump(pk, `版:${x.prompt_version}`);
  bump(pk, `取得元:${x.url_status}`);
  bump(pk, `判断:${x.decision}/${x.verified ? "検証済" : "未検証"}`);
  if ((x.pages ?? []).some((g) => g.at)) bump(pk, "ページの取得時刻あり");
}
p("新AIの登録案", { 件数: props.length, ...pk });
const cov = (await db.from("evidence_coverage_stats").select("source_chars,shown_chars,reads,read_chars,view_mode,mode,created_at").eq("mode", "real").gte("created_at", since)).data ?? [];
p("AIへの提示（計測）", { ページ: cov.length, 全文字: cov.reduce((s, c) => s + c.source_chars, 0), 提示: cov.reduce((s, c) => s + c.shown_chars, 0), 追加read: cov.reduce((s, c) => s + c.read_chars, 0), 索引表示: cov.filter((c) => c.view_mode === "indexed").length });

const jobs = (await db.from("shadow_jobs").select("status,skip_reason,last_error,updated_at").gte("updated_at", since)).data ?? [];
const jk = {};
for (const j of jobs) bump(jk, `${j.status}:${j.last_error ?? j.skip_reason ?? ""}`.slice(0, 50));
p("シャドーのジョブ", jk);
const sj = (await db.from("shadow_judgments").select("cost_jpy,status").gte("created_at", since)).data ?? [];
p("シャドーの実行", { 件数: sj.length, 費用円: Math.round(sj.reduce((s, r) => s + Number(r.cost_jpy ?? 0), 0) * 100) / 100 });
const bmRuns = (await db.from("collection_runs").select("started_at").eq("phase", "bookmark").gte("started_at", since)).data ?? [];
const hours = Math.max(1, (Date.now() - new Date(since).getTime()) / 3600_000);
p("ブックマーク同期の実行（1時間あたり）", Math.round((bmRuns.length / hours) * 10) / 10);
const lr = (await db.from("link_recheck_tasks").select("status").gte("created_at", since)).data ?? [];
const lk = {};
for (const t of lr) bump(lk, t.status);
p("未取得リンクの再調査", lk);
