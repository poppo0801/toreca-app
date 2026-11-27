// EVIDENCE_UTILIZATION §3: 項目の取りこぼしの原因の切り分け（無課金・ローカルのみ。原文・値は出さない。件数・項目名・区分だけ）。
//   node scripts/intensive-diagnose.mjs --run=<名前> [--sets=unseen3]
// 正解に記載がある項目のうち、AIが取れなかった（missing・wrong・記載なし判定）ものについて、正解の照合語が
//   ①種（投稿・カード）にある → 提示済み ②調査で使ったページ（記録の pages のハッシュ）にある → 提示済み（12,000字以下）／長文（提示範囲外の可能性）
//   ③候補の収集時の素材（リンク先・保存文書）にはあるが調査で使っていない → 取得・提示されず ④どこにも無い → 証拠に無い（公式に未到達・二次情報のみ）
// に分けて数える。正解はAIに渡さない（AIを呼ばない）。
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 下で止める */
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
  console.error("ローカルDBだけを対象にします（.env.local の接続先がローカルではありません）");
  process.exit(2);
}
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const run = arg("run");
const sets = (arg("sets") ?? "").split(",").filter(Boolean);
const path = `eval/intensive/runs/${run}.local.jsonl`;
if (!run || !existsSync(path)) {
  console.error("--run=<名前>（記録あり）が必要です");
  process.exit(2);
}
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const gold = JSON.parse(readFileSync("eval/intensive/gold.local.json", "utf8")).cases;
const rows = new Map(JSON.parse(readFileSync("eval/intensive/cases.local.json", "utf8")).rows.map((r) => [String(r.id).slice(0, 8), r]));
const nf = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const DATE = new Set(["apply_start", "apply_end", "deadline", "result_at", "result_end", "purchase_start", "purchase_end", "receive_start", "receive_end"]);
/** 正解の値が本文に現れるかの照合語（文字の項目は t、日付は「月/日」の書き方、数値は数字） */
function probes(k, f) {
  if (DATE.has(k)) {
    const m = /(?:(\d{4})[-/年.])?(\d{1,2})[-/月.](\d{1,2})/.exec(String(f.v ?? "").normalize("NFKC"));
    if (!m) return [];
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const p2 = (x) => String(x).padStart(2, "0");
    return [`${mo}/${d}`, `${mo}月${d}日`, `${p2(mo)}/${p2(d)}`, `${mo}.${d}`, `${p2(mo)}月${p2(d)}日`, ...(m[1] ? [`${m[1]}-${p2(mo)}-${p2(d)}`, `${m[1]}/${p2(mo)}/${p2(d)}`, `${m[1]}/${mo}/${d}`] : [])];
  }
  if (k === "price" || k === "per_person_limit") return [String(f.v ?? "").replace(/\D/g, "")].filter((x) => x.length >= 1);
  if (k === "receive_method") return f.v === "shipping" ? ["発送", "配送", "郵送", "お届け"] : f.v === "store" ? ["店頭", "店舗", "来店", "お渡し", "受取", "受け取"] : [];
  if (k === "apply_unit") return [];
  return (f.t?.length ? f.t : [f.v]).filter(Boolean).map(String);
}
const appears = (text, ps) => ps.length > 0 && ps.some((p) => nf(text).includes(nf(p)));
const GK = { apply_end: "deadline" };
const canonOf = (rec) => {
  const o = {};
  for (const [k, v] of Object.entries(rec?.fields ?? {})) if (!k.startsWith("_")) o[k] = v;
  return o;
};

const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => !sets.length || sets.includes(l.set));
const last = new Map();
for (const l of lines) last.set(l.caseId, l);
const out = { 案件: 0, 対象項目: 0, 区分: {}, 項目別: {}, 判断別: {} };
const bump = (m, k) => (m[k] = (m[k] ?? 0) + 1);
for (const [caseId, l] of last) {
  const g = gold[caseId];
  const row = rows.get(caseId);
  if (!g || !row) continue;
  out.案件++;
  const opps = Array.isArray(g.opportunities) && g.opportunities.length ? g.opportunities : [{ fields: g.fields }];
  if (opps.length > 1) continue; // 複数機会の案件は対応づけが別（採点 v3 の機会単位で扱う）。ここは単一機会だけ
  const rec = (l.records ?? [])[0];
  const ai = canonOf(rec);
  // 素材: 種（投稿・カード）、調査で使ったページ（記録の pages のハッシュ）、候補の収集時の素材
  const seed = [row.post?.text, row.title, row.evidence?.text].filter(Boolean).join("\n");
  const used = new Set((rec?.pages ?? []).map((p) => p.hash).filter(Boolean));
  const docs = (await db.from("evidence_documents").select("text,text_chars,content_hash,origin").eq("candidate_id", row.id)).data ?? [];
  const usedDocs = docs.filter((d) => used.has(String(d.content_hash).slice(0, 16)) || used.has(sha16(d.text)));
  const material = [...(row.linkedPages ?? []).map((p) => p.text), ...(row.documents ?? []).map((d) => d.text), ...docs.map((d) => d.text)].filter(Boolean).join("\n");
  for (const [k0, f] of Object.entries(opps[0].fields ?? {})) {
    if (f.s === "not_stated") continue;
    const k = GK[k0] ?? k0;
    const a = ai[k];
    const status = a?.absence ? "記載なしと判定" : !a?.value || a?.basis === "unknown" ? "未記入" : null;
    if (!status) continue; // 値がある（正誤は採点で別に見る）
    out.対象項目++;
    const ps = probes(k0, f);
    let where;
    if (!ps.length) where = "照合語なし（判定できない）";
    else if (appears(seed, ps)) where = "種に記載あり（提示済み）";
    else if (usedDocs.some((d) => appears(d.text, ps) && d.text.length <= 12000)) where = "調査のページに記載あり（全文提示）";
    else if (usedDocs.some((d) => appears(d.text, ps))) where = "調査のページに記載あり（長文・提示範囲外の可能性）";
    else if (appears(material, ps)) where = "収集時の素材にあるが調査で使っていない";
    else where = "証拠に無い（公式未到達・二次情報のみ等）";
    bump(out.区分, where);
    bump((out.項目別[k] ??= {}), where);
    bump((out.判断別[`${rec?.decision ?? "none"}`] ??= {}), where);
  }
}
console.log(JSON.stringify(out, null, 1));
