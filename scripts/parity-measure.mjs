// PRODUCTION_PARITY §2: 文字情報の取得・保存・AIへの提示の実測（読み取りのみ。原文・URL・値は出さない。件数・字数・理由コードだけ）。
//   npm run prod -- scripts/parity-measure.mjs [--days=7] [--json=<出力先>] --yes-production
// 期間は候補の最終確認時刻（last_checked_at）または作成時刻で絞る。設定上限ではなく、保存された実測（本文の字数・切り詰めで失った字数・リンク先の全文字数・保存文書・提示/readの区間）を集計する。
// 元ページの総文字数が記録されていないもの（取得前・HTMLのバイト数・整形前の字数）は「未記録」とし、推定しない。
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("parity-measure.mjs");
const opt = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const days = Number(opt("days") ?? 7);
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function all(q, page = 500) {
  const out = [];
  for (let from = 0; ; from += page) {
    const r = await q().range(from, from + page - 1);
    if (r.error) throw new Error(r.error.message);
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < page) break;
  }
  return out;
}

const cands = await all(() => db.from("collection_candidates").select("id,created_at,last_checked_at,status,job_state,x_post_id,last_good").or(`last_checked_at.gte.${since},created_at.gte.${since}`).order("created_at"));
const ids = cands.map((c) => c.id);
const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const docs = [];
const props = [];
for (const part of chunk(ids, 150)) {
  docs.push(...(await all(() => db.from("evidence_documents").select("candidate_id,kind,origin,text_chars,source_chars,truncated,truncated_reason,fetched_at,created_at").in("candidate_id", part))));
  props.push(...(await all(() => db.from("registration_proposals").select("candidate_id,proposal_key,mode,url_status,decision,verified,pages,created_at,superseded_at").in("candidate_id", part).eq("mode", "real"))));
}
const keys = [...new Set(props.map((p) => p.proposal_key))];
const cov = [];
for (const part of chunk(keys, 150)) cov.push(...(await all(() => db.from("evidence_coverage_stats").select("proposal_key,host,source_chars,truncated,view_mode,shown_chars,reads,read_chars,fetch_outcome,mode,created_at").in("proposal_key", part).eq("mode", "real"))));

const stat = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const sum = v.reduce((s, x) => s + x, 0);
  return { n: v.length, mean: Math.round(sum / v.length), median: v[Math.floor(v.length / 2)], min: v[0], max: v[v.length - 1], sum };
};
const bump = (m, k, n = 1) => (m[k] = (m[k] ?? 0) + n);

const groups = {};
const g = (k) => (groups[k] ??= { candidates: 0, withEvidence: 0, noEvidence: 0, statuses: {}, textChars: [], textLostChars: [], truncated: 0, links: [], linkMap: [], tcoInText: [], tcoUnmapped: 0, linkedPages: [], lpExcerptChars: [], lpFullChars: [], lpTruncated: 0, ledgerStatus: {}, ledgerReasons: {}, images: { withImages: 0, imageCount: [], refs: 0, readings: 0, status: {} }, docs: { candidatesWithDocs: 0, byOrigin: {}, chars: [], truncated: 0 }, limitHits: {} });
for (const c of cands) {
  const ev = c.last_good?.evidence;
  const kind = ev?.v ? `${ev.via ?? "?"}/${ev.textSource ?? "?"}` : `none/${c.x_post_id ? "x" : "web"}`;
  for (const key of ["ALL", kind]) {
    const x = g(key);
    x.candidates++;
    bump(x.statuses, `${c.status}/${c.job_state}`);
    if (!ev?.v || typeof ev.text !== "string") {
      x.noEvidence++;
      continue;
    }
    x.withEvidence++;
    x.textChars.push(ev.text.length);
    x.textLostChars.push(ev.limitHits?.textTruncated ?? 0);
    if (ev.truncated) x.truncated++;
    x.links.push((ev.links ?? []).length);
    x.linkMap.push((ev.linkMap ?? []).length);
    const tco = (ev.text.match(/https:\/\/t\.co\/[A-Za-z0-9]+/g) ?? []).length;
    x.tcoInText.push(tco);
    if (tco > 0 && !(ev.linkMap ?? []).length) x.tcoUnmapped++;
    const lps = ev.linkedPages ?? [];
    x.linkedPages.push(lps.length);
    for (const p of lps) {
      x.lpExcerptChars.push(p.text?.length ?? 0);
      if (typeof p.fullChars === "number") x.lpFullChars.push(p.fullChars);
      if (p.truncated) x.lpTruncated++;
    }
    for (const l of ev.linkLedger ?? []) {
      bump(x.ledgerStatus, l.status);
      if (l.status !== "fetched") bump(x.ledgerReasons, String(l.reason ?? "?").split(":")[0].slice(0, 30));
    }
    for (const [k, n] of Object.entries(ev.limitHits ?? {})) bump(x.limitHits, k, n);
    if ((ev.imageCount ?? 0) > 0) {
      x.images.withImages++;
      x.images.imageCount.push(ev.imageCount);
      if ((ev.imageRefs ?? []).length) x.images.refs++;
      if ((ev.imageReadings ?? []).length) x.images.readings++;
      bump(x.images.status, ev.imageStatus ?? "?");
    }
    const ds = docs.filter((d) => d.candidate_id === c.id);
    if (ds.length) x.docs.candidatesWithDocs++;
    for (const d of ds) {
      bump(x.docs.byOrigin, `${d.kind}:${d.origin}`);
      x.docs.chars.push(d.text_chars);
      if (d.truncated) x.docs.truncated++;
    }
  }
}
// 原文の取得日（evidence.fetchedAt）別: 現行コードの保存構造（textSource・台帳・linkMap・リンク先・画像参照）が実際に付いているか
const byDay = {};
for (const c of cands) {
  const ev = c.last_good?.evidence;
  const day = ev?.fetchedAt ? String(ev.fetchedAt).slice(0, 10) : "no_evidence";
  const d = (byDay[day] ??= { n: 0, x: 0, web: 0, textSource: 0, fetchedPage: 0, card: 0, ledger: 0, linkMap: 0, tcoUnmapped: 0, linkedPages: 0, lpFullRecorded: 0, imageCount: 0, imageRefs: 0, statuses: {} });
  d.n++;
  bump(d.statuses, `${c.status}/${c.job_state}`);
  if (!ev?.v) continue;
  if (ev.via === "x_api" || ev.via === "x_oembed") d.x++;
  else d.web++;
  if (ev.textSource) d.textSource++;
  if (ev.textSource === "fetched_page") d.fetchedPage++;
  if (ev.textSource === "card_or_context" || ev.textSource === "list_card") d.card++;
  if ((ev.linkLedger ?? []).length) d.ledger++;
  if ((ev.linkMap ?? []).length) d.linkMap++;
  if ((ev.text.match(/https:\/\/t\.co\//g) ?? []).length && !(ev.linkMap ?? []).length) d.tcoUnmapped++;
  if ((ev.linkedPages ?? []).length) d.linkedPages++;
  if ((ev.linkedPages ?? []).some((p) => typeof p.fullChars === "number")) d.lpFullRecorded++;
  if ((ev.imageCount ?? 0) > 0) d.imageCount++;
  if ((ev.imageRefs ?? []).length) d.imageRefs++;
}
const out = { since, days, candidates: cands.length, byDay, groups: {} };
for (const [k, x] of Object.entries(groups)) {
  out.groups[k] = { ...x, textChars: stat(x.textChars), textLostChars: stat(x.textLostChars.filter((n) => n > 0)), links: stat(x.links), linkMap: stat(x.linkMap), tcoInText: stat(x.tcoInText), linkedPages: stat(x.linkedPages), lpExcerptChars: stat(x.lpExcerptChars), lpFullChars: stat(x.lpFullChars), images: { ...x.images, imageCount: stat(x.images.imageCount) }, docs: { ...x.docs, chars: stat(x.docs.chars) } };
}
// 新AI（実AI）が実際に提示された文字: 計測行（ページごと）。shown=入力に出た区間の合計、read=追加readの区間の合計、source=そのページの全文字数（保存または取得の本文）
const covBy = { pages: cov.filter((c) => c.host !== "none").length, noPage: cov.filter((c) => c.host === "none").length, sourceChars: stat(cov.filter((c) => c.host !== "none").map((c) => c.source_chars)), shownChars: stat(cov.filter((c) => c.host !== "none").map((c) => c.shown_chars)), readChars: stat(cov.filter((c) => c.reads > 0).map((c) => c.read_chars)), withReads: cov.filter((c) => c.reads > 0).length, indexed: cov.filter((c) => c.view_mode === "indexed").length, shownRatio: stat(cov.filter((c) => c.host !== "none" && c.source_chars > 0).map((c) => Math.round((Math.min(c.shown_chars + c.read_chars, c.source_chars) / c.source_chars) * 100))), outcomes: {} };
for (const c of cov) bump(covBy.outcomes, c.fetch_outcome);
out.aiShown = covBy;
const pr = { records: props.length, current: props.filter((p) => !p.superseded_at).length, urlStatus: {}, decisions: {}, pagesPerRecord: stat(props.map((p) => (p.pages ?? []).length)) };
for (const p of props) {
  bump(pr.urlStatus, p.url_status);
  bump(pr.decisions, `${p.decision}/${p.verified ? "v" : "nv"}`);
}
out.proposals = pr;
const j = opt("json");
if (j) writeFileSync(j, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1).slice(0, 20000));
