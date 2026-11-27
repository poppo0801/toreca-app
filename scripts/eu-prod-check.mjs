// EVIDENCE_UTILIZATION §1: 前回の本番未確認事項の確認（読み取りのみ。原文・URL・値は出さない。件数・字数・状態・理由コードだけ）。
//   npm run prod -- scripts/eu-prod-check.mjs [--since=<ISO>] --yes-production
// Web告知の全文保存・X停止期間の投稿の補完・取り直し時の全文・画像（参照→取得→解析）・未取得リンクの再調査・再評価の抑制・シャドーの待ち行列・自律型の発見。
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("eu-prod-check.mjs");
const since = process.argv.find((a) => a.startsWith("--since="))?.slice(8) ?? "2026-11-26T13:10:00Z";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const bump = (m, k, n = 1) => (m[k] = (m[k] ?? 0) + n);
const p = (l, v) => console.log(l, typeof v === "string" ? v : JSON.stringify(v));
async function all(q, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const r = await q().range(from, from + page - 1);
    if (r.error) {
      out.error = r.error.message.slice(0, 80);
      return out;
    }
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < page) break;
  }
  return out;
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] } : { n: 0 };
};
const hours = (a, b) => Math.round(((new Date(b).getTime() - new Date(a).getTime()) / 3600_000) * 10) / 10;
// X の投稿IDの時刻（snowflake）
const postTime = (id) => {
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1288834974657n)).toISOString();
  } catch {
    return null;
  }
};

// 1) Web 告知の全文保存（Web候補 × 収集由来の文書）
const cands = await all(() => db.from("collection_candidates").select("id,status,job_state,x_post_id,created_at,last_checked_at,last_good").gte("last_checked_at", since));
const docs = await all(() => db.from("evidence_documents").select("candidate_id,kind,origin,text_chars,source_chars,truncated,truncated_reason,structure,created_at").gte("created_at", since));
const docBy = new Map();
for (const d of docs) (docBy.get(d.candidate_id) ?? docBy.set(d.candidate_id, []).get(d.candidate_id)).push(d);
const web = cands.filter((c) => !c.x_post_id && c.last_good?.evidence?.v);
const wk = {};
for (const c of web) {
  const ev = c.last_good.evidence;
  const ds = (docBy.get(c.id) ?? []).filter((d) => d.origin.startsWith("collector"));
  bump(wk, `via=${ev.via}/${ds.length ? "全文あり" : "全文なし"}`);
}
p("Web候補の全文保存", { Web候補: web.length, ...wk });
// 解析（取得）まで進んだWeb候補だけ（一覧の再確認だけの候補は取得しないので全文は作られない）
const webDone = await all(() => db.from("collection_candidates").select("id,x_post_id,completed_at,created_at,last_good").is("x_post_id", null).gte("completed_at", since));
const wd = {};
for (const c of webDone) {
  const ev = c.last_good?.evidence;
  const has = (docBy.get(c.id) ?? []).some((d) => d.origin.startsWith("collector"));
  wd[`via=${ev?.via ?? "なし"}/${has ? "全文あり" : "全文なし"}${c.created_at >= since ? "/新規" : "/既存"}`] = (wd[`via=${ev?.via ?? "なし"}/${has ? "全文あり" : "全文なし"}${c.created_at >= since ? "/新規" : "/既存"}`] ?? 0) + 1;
}
p("解析まで進んだWeb候補の全文保存（completed_at が期間内）", { 件数: webDone.length, ...wd });
const docKinds = {};
for (const d of docs) bump(docKinds, `${d.kind}:${d.origin}:${d.structure ? "構造あり" : "構造なし"}${d.truncated ? `:切詰(${d.truncated_reason})` : ""}`);
p("全文の保存（由来・構造）", docKinds);

// 2) X 停止期間（11/23 06:40 JST 〜 11/26 22:10 JST）の投稿の補完
const gapFrom = "2026-11-22T21:40:00Z";
const gapTo = "2026-11-26T13:10:00Z";
const xc = await all(() => db.from("collection_candidates").select("id,x_post_id,status,job_state,lottery_id,created_at").not("x_post_id", "is", null).gte("created_at", gapFrom));
const inGap = xc.filter((c) => {
  const t = postTime(c.x_post_id);
  return t && t >= gapFrom && t < gapTo;
});
const gk = {};
for (const c of inGap) bump(gk, `${c.status}/${c.job_state}${c.lottery_id ? "/登録あり" : ""}`);
const byDay = {};
for (const c of inGap) bump(byDay, postTime(c.x_post_id).slice(0, 10));
p("X停止期間の投稿（後から収集された候補）", { 件数: inGap.length, 投稿日別: byDay, 状態: gk, 収集までの時間h: stats(inGap.map((c) => hours(postTime(c.x_post_id), c.created_at))) });
const dupIds = {};
for (const c of xc) bump(dupIds, c.x_post_id);
p("同じ投稿IDの候補の重複", Object.values(dupIds).filter((n) => n > 1).length);
// 期限切れの告知が通知・登録を発生させていないか（停止期間の投稿から作られた抽選と、その通知）
const gapLots = inGap.filter((c) => c.lottery_id).map((c) => c.lottery_id);
if (gapLots.length) {
  const lots = (await db.from("lotteries").select("id,apply_deadline_at,apply_deadline_date,created_at").in("id", gapLots)).data ?? [];
  const expired = lots.filter((l) => {
    const d = l.apply_deadline_at ?? (l.apply_deadline_date ? `${l.apply_deadline_date}T15:00:00Z` : null);
    return d && d < l.created_at;
  });
  p("停止期間の投稿から登録された抽選", { 件数: lots.length, 登録時点で締切済み: expired.length });
} else p("停止期間の投稿から登録された抽選", { 件数: 0 });

// 3) X の取り直し・リンクの全文
const xk = {};
for (const c of cands.filter((c) => c.x_post_id && c.last_good?.evidence?.v)) {
  const ev = c.last_good.evidence;
  const fetched = (ev.linkLedger ?? []).filter((e) => e.status === "fetched").length;
  const ds = (docBy.get(c.id) ?? []).filter((d) => d.kind === "page" && d.origin.startsWith("collector")).length;
  bump(xk, fetched === 0 ? "取得リンク0" : ds >= fetched ? "取得リンクの全文あり" : ds > 0 ? "一部のみ全文" : "全文なし");
  if (ev.textSource) bump(xk, `原文:${ev.via}/${ev.textSource}`);
}
p("X候補のリンク先の全文", xk);

// 4) 画像（参照 → 取得 → 解析）
const img = await all(() => db.from("evidence_image_observations").select("status,mode,failure_reason,created_at").gte("created_at", since));
const ik = {};
for (const r of img) bump(ik, `${r.mode}:${r.status}${r.failure_reason ? `:${r.failure_reason}` : ""}`);
const refs = cands.reduce((s, c) => s + (c.last_good?.evidence?.imageRefs?.length ?? 0), 0);
p("画像", { 参照: refs, 取得・解析の記録: img.error ? `読めない ${img.error}` : ik });

// 5) 未取得リンクの再調査
const lr = await all(() => db.from("link_recheck_tasks").select("status,attempts,last_error,reason,next_attempt_at,expires_at,created_at,done_at,updated_at"));
const lk = {};
for (const t of lr) bump(lk, `${t.status}:${t.reason}${t.last_error ? `:${String(t.last_error).slice(0, 24)}` : ""}:試行${t.attempts}`);
p("未取得リンクの再調査（全件）", { 件数: lr.length, 内訳: lk, 期限切れ: lr.filter((t) => t.status === "pending" && t.expires_at < new Date().toISOString()).length, 次回が過去: lr.filter((t) => t.status === "pending" && t.next_attempt_at < new Date().toISOString()).length });

// 6) シャドーの待ち行列・再評価の抑制・費用
const jobs = await all(() => db.from("shadow_jobs").select("id,candidate_id,status,last_error,skip_reason,attempts,next_run_at,created_at,updated_at,evidence_hash"));
const jk = {};
for (const j of jobs.filter((j) => j.updated_at >= since)) bump(jk, `${j.status}:${(j.last_error ?? j.skip_reason ?? "").slice(0, 30)}`);
const queued = jobs.filter((j) => j.status === "queued");
p("シャドーのジョブ（期間内に更新）", jk);
p("待ち行列", { 件数: queued.length, 最古の作成からh: queued.length ? hours(queued.map((j) => j.created_at).sort()[0], new Date().toISOString()) : 0, 候補数: new Set(queued.map((j) => j.candidate_id)).size, 形式: { 旧32桁本文: queued.filter((j) => j.evidence_hash.length === 32).length } });
const sj = await all(() => db.from("shadow_judgments").select("candidate_id,cost_jpy,status,created_at").gte("created_at", since));
const perDay = {};
for (const r of sj) bump(perDay, new Date(new Date(r.created_at).getTime() + 9 * 3600_000).toISOString().slice(0, 10), Number(r.cost_jpy ?? 0));
p("シャドーの実行（期間内）", { 件数: sj.length, 候補数: new Set(sj.map((r) => r.candidate_id)).size, 日本時間の日別円: Object.fromEntries(Object.entries(perDay).map(([k, v]) => [k, Math.round(v * 100) / 100])) });
const props = await all(() => db.from("registration_proposals").select("candidate_id,decision,verified,url_status,prompt_version,created_at").eq("mode", "real").gte("created_at", since));
const pk = {};
for (const x of props) bump(pk, `${x.prompt_version}:${x.decision}/${x.verified ? "検証済" : "未検証"}:${x.url_status}`);
p("新AIの登録案（期間内）", { 件数: props.length, 内訳: pk });

// 7) 自律型の発見（AUTONOMOUS_COLLECTION。別予算）
const dr = await all(() => db.from("discovery_runs").select("*").gte("created_at", "2026-11-16T00:00:00Z").order("created_at"));
const dk = {};
for (const r of dr) bump(dk, `${r.status ?? r.result ?? "?"}`);
p("発見の実行の列", dr[0] ? Object.keys(dr[0]) : dr.error ?? []);
p("発見の実行（11/16以降）", { 件数: dr.length, 状態: dk, 費用円: Math.round(dr.reduce((s, r) => s + Number(r.cost_jpy ?? r.spent_jpy ?? 0), 0) * 100) / 100 });
for (const r of dr.filter((r) => /fail|error/i.test(String(r.status ?? r.result ?? "")))) p("発見の失敗", { at: r.created_at, 状態: r.status ?? r.result, 理由: String(r.error ?? r.error_code ?? r.last_error ?? r.message ?? "").slice(0, 80) });
