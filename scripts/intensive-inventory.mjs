// Phase 3 INTENSIVE_EVALUATION: 本番の実案件の棚卸し（読み取りのみ。DB・候補・登録案は一切変更しない）。
//   npm run prod -- scripts/intensive-inventory.mjs [--export] --yes-production
// 画面（標準出力）には件数・種別・ホスト名の集計だけを出す（原文・URL全体・個人情報は出さない）。
// --export のときだけ、評価用の原文（公開の投稿・公開ページ・保存した全文・画像の参照・現行の判断）を Git管理外の eval/intensive/cases.local.json に書き出す
// （正解ではない。正解は別ファイル eval/intensive/gold.local.json に、原文を独立に照合して作る）。
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("intensive-inventory.mjs");
const EXPORT = process.argv.includes("--export");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function all(table, cols, build = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(db.from(table).select(cols)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const host = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return "?";
  }
};
const bump = (m, k) => (m[k] = (m[k] ?? 0) + 1);

const cands = await all("collection_candidates", "id,source_id,kind,status,job_state,lottery_id,source_url,x_post_id,title,fetched_at,created_at,last_good,draft,reasons,triage,manual_state,manual_reason,due_at");
const docs = await all("evidence_documents", "candidate_id,url,origin,kind,text_chars,truncated,fetched_at,content_hash");
const props = await all("registration_proposals", "candidate_id,mode,decision,verified,superseded_at,model_id,prompt_version,created_at");
const imgs = await all("evidence_image_observations", "candidate_id,mode,status");
const reviews = await all("registration_proposal_reviews", "kind,verdict,candidate_id,created_at");
const exps = await all("investigation_experiences", "source,mode,verification,recorded_at,experience_version");
const lots = await all("lotteries", "id,source_kind,created_at,archived_at,source_urls");

const docsBy = new Map();
for (const d of docs) docsBy.set(d.candidate_id, [...(docsBy.get(d.candidate_id) ?? []), d]);
const propsBy = new Map();
for (const p of props) propsBy.set(p.candidate_id, [...(propsBy.get(p.candidate_id) ?? []), p]);
const imgBy = new Map();
for (const i of imgs) imgBy.set(i.candidate_id, [...(imgBy.get(i.candidate_id) ?? []), i]);

const summary = { 候補: cands.length, 状態: {}, ジョブ: {}, 種別: {}, 抽選に登録済み: 0, 証拠: { 原文あり: 0, リンク先ページあり: 0, 全文保存あり: 0, 画像参照あり: 0, 画像解析あり: 0, 原文なし: 0 }, 登録案: { 候補数: 0, 実AI: 0, 現行版: 0 }, 情報源ホスト上位: {}, 収集月: {}, 正解記録: {}, 経験: {}, 抽選: { 件数: lots.length, 由来: {} } };
const hostCount = {};
for (const c of cands) {
  bump(summary.状態, c.status);
  bump(summary.ジョブ, c.job_state);
  bump(summary.種別, c.kind ?? "?");
  if (c.lottery_id) summary.抽選に登録済み++;
  const ev = c.last_good?.evidence;
  if (ev?.text) summary.証拠.原文あり++;
  else summary.証拠.原文なし++;
  if (ev?.linkedPages?.length) summary.証拠.リンク先ページあり++;
  if (docsBy.has(c.id)) summary.証拠.全文保存あり++;
  if (ev?.imageRefs?.length) summary.証拠.画像参照あり++;
  if ((imgBy.get(c.id) ?? []).some((i) => i.status === "analyzed")) summary.証拠.画像解析あり++;
  if (propsBy.has(c.id)) summary.登録案.候補数++;
  for (const l of ev?.linkedPages ?? []) bump(hostCount, host(l.url));
  bump(summary.収集月, String(c.fetched_at ?? c.created_at).slice(0, 7));
}
summary.登録案.実AI = props.filter((p) => p.mode === "real").length;
summary.登録案.現行版 = props.filter((p) => !p.superseded_at).length;
summary.情報源ホスト上位 = Object.fromEntries(Object.entries(hostCount).sort((a, b) => b[1] - a[1]).slice(0, 30));
for (const r of reviews) bump(summary.正解記録, `${r.kind}:${r.verdict ?? "-"}`);
for (const e of exps) bump(summary.経験, `${e.source}/${e.mode}/${e.verification}`);
for (const l of lots) bump(summary.抽選.由来, `${l.source_kind}${l.archived_at ? "(済)" : ""}`);
console.log(JSON.stringify(summary, null, 1));

if (EXPORT) {
  mkdirSync("eval/intensive", { recursive: true });
  const rows = cands
    .filter((c) => c.last_good?.evidence?.text)
    .map((c) => {
      const ev = c.last_good.evidence;
      return {
        id: c.id,
        kind: c.kind,
        status: c.status,
        jobState: c.job_state,
        registeredLottery: !!c.lottery_id,
        sourceUrl: c.source_url,
        fetchedAt: ev.fetchedAt ?? c.fetched_at,
        createdAt: c.created_at,
        title: c.title,
        post: { text: ev.text, links: ev.links ?? [], linkMap: ev.linkMap ?? [] },
        linkedPages: (ev.linkedPages ?? []).map((l) => ({ url: l.url, text: l.text })),
        imageRefs: ev.imageRefs ?? [],
        imageReadings: (ev.imageReadings ?? []).map((r) => ({ field: r.field, text: r.text, imageIndex: r.imageIndex })),
        documents: (docsBy.get(c.id) ?? []).map((d) => ({ url: d.url, origin: d.origin, chars: d.text_chars, truncated: d.truncated, fetchedAt: d.fetched_at, hash: d.content_hash })),
        // 現行方式の判断（参照用。正解ではない）
        legacy: { draft: c.draft ?? null, reasons: c.reasons ?? [], triage: c.triage ?? null, manual: c.manual_state ?? null },
        proposals: (propsBy.get(c.id) ?? []).length,
      };
    });
  // 保存済みの全文（収集・事前取得の時点の原文。現在のページとは別の時点の記録）と、収集時の証拠の全体（再生用）
  const withDocs = new Set(rows.filter((r) => r.documents.length).map((r) => r.id));
  const full = [];
  for (const id of withDocs) {
    const { data } = await db.from("evidence_documents").select("candidate_id,url,origin,kind,text,structure,text_loss,truncated,truncated_reason,fetched_at,content_hash,text_chars,source_chars").eq("candidate_id", id);
    full.push(...(data ?? []));
  }
  const evBy = new Map(cands.map((c) => [c.id, c.last_good?.evidence ?? null]));
  for (const r of rows) r.evidence = evBy.get(r.id);
  const st = (await db.from("collection_settings").select("prefectures,include_online").limit(1).maybeSingle()).data;
  writeFileSync("eval/intensive/region.local.json", JSON.stringify(st ?? {}, null, 1));
  writeFileSync("eval/intensive/documents.local.json", JSON.stringify(full, null, 1));
  writeFileSync("eval/intensive/cases.local.json", JSON.stringify({ exportedAt: new Date().toISOString(), rows }, null, 1));
  console.log(`書き出し: eval/intensive/cases.local.json（${rows.length}件・Git管理外）`);
}
