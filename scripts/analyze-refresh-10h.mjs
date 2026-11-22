// Stage 10H: 10G（基準）と10H（フェーズ1=入力設計のみ／フェーズ2=公開ページ取得を加えた再判断）の指標を比較する。**オフライン。標準出力は件数・統計のみ**。
//   node scripts/analyze-refresh-10h.mjs
import { readdirSync, readFileSync } from "node:fs";

const dir = "eval/real-data";
const latest = (prefix) => readdirSync(dir).filter((x) => x.startsWith(prefix)).sort().at(-1);
const g = JSON.parse(readFileSync(`${dir}/${latest("refresh-10g-")}`, "utf8"));
// 本実行（最初のファイル）＋修正の再実行（後続のファイル。指定した添字だけを置き換える。費用・呼び出しは合算）
const hFiles = readdirSync(dir).filter((x) => x.startsWith("refresh-10h-")).sort();
const h = JSON.parse(readFileSync(`${dir}/${hFiles[0]}`, "utf8"));
const patched = [];
for (const f of hFiles.slice(1)) {
  const p = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  p.phase1.forEach((r, i) => { if (r) { h.phase1[i] = r; patched.push(i); } });
  h.spentJpy += p.spentJpy;
  h.calls += p.calls;
}
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　・･\-－ー()（）]/g, "");
const cl = (p, k) => (p && p[k] && p[k].value && p[k].basis !== "unknown" ? p[k].value : null);
const by = (arr, k) => arr.reduce((m, x) => ((m[k(x)] = (m[k(x)] ?? 0) + 1), m), {});

function metrics(R) {
  const out = R.filter((r) => r.output);
  const qs = out.flatMap((r) => r.output.unresolved);
  const isId = (q) => /R1|N\d|既存|currentCase|登録/.test(q) && /(同一|同じ|same|応募権|一致)/.test(q);
  const m = {
    n: R.length,
    status: by(R, (r) => r.status),
    attempts: by(R, (r) => r.attempts),
    structure: by(out, (r) => r.output.structure.kind),
    unknown: out.filter((r) => r.output.structure.kind === "unknown").length,
    opportunityCount: by(out, (r) => r.output.opportunities.length),
    casesWithUnresolved: out.filter((r) => r.output.unresolved.length > 0).length,
    questions: qs.length,
    importance: by(qs, (u) => u.importance),
    selfIdentityQuestions: qs.filter((u) => isId(u.question) && /currentCase|R1|この案件/.test(u.question)).length,
    yearQuestions: qs.filter((u) => /年/.test(u.question) && /(推定|解釈|不明|確認)/.test(u.question)).length,
    casesWithHighQuestion: out.filter((r) => r.output.unresolved.some((u) => u.importance === "high")).length,
    cost: +R.reduce((a, r) => a + r.costJpy, 0).toFixed(2),
    avgLatencyMs: Math.round(R.reduce((a, r) => a + r.latencyMs, 0) / Math.max(1, R.length)),
    violationCodes: by(R.flatMap((r) => r.violationCodes), (c) => c),
    plannedChanges: by(out.flatMap((r) => r.output.plannedChanges), (c) => c.op),
    nextActions: by(out.flatMap((r) => r.output.nextActions), (a) => a.kind),
    citedFacts: (() => { let f = 0, c = 0; for (const r of out) for (const x of [r.output.caseType, ...r.output.opportunities.flatMap((o) => [o.chain, o.store, o.products, o.applyStart, o.applyDeadline, o.resultDate, o.conditions])]) if (x && x.basis === "fact") { f++; if (x.citations?.length) c++; } return { facts: f, cited: c }; })(),
  };
  // 登録値との整合（比較できる項目のみ）
  const cmp = { chain: [0, 0], store: [0, 0], deadline: [0, 0], products: [0, 0] };
  for (const r of out) {
    const e = r.existing;
    const p = r.output.opportunities[0];
    const c = cl(p, "chain");
    if (c && e.chain) cmp.chain[norm(c).includes(norm(e.chain)) || norm(e.chain).includes(norm(c)) ? 0 : 1]++;
    const s = cl(p, "store");
    if (s && e.store) cmp.store[norm(s).includes(norm(e.store)) || norm(e.store).includes(norm(s)) ? 0 : 1]++;
    const dls = r.output.opportunities.map((x) => cl(x, "applyDeadline")).filter(Boolean);
    if (dls.length && e.applyDeadline) cmp.deadline[dls.some((x) => String(x).includes(e.applyDeadline)) ? 0 : 1]++;
    const pr = r.output.opportunities.flatMap((x) => cl(x, "products") ?? []);
    if (pr.length && e.products.length) cmp.products[pr.some((x) => e.products.some((y) => norm(x).includes(norm(y)) || norm(y).includes(norm(x)))) ? 0 : 1]++;
  }
  m.registrationMatch = Object.fromEntries(Object.entries(cmp).map(([k, [a, b]]) => [k, { equal: a, differ: b }]));
  return m;
}

const p1 = h.phase1;
const p2 = h.phase2;
const base = metrics(g.results);
const imp = metrics(p1);
// フェーズ2の対象だけを、フェーズ1の同一対象と対比（取得による改善を分離）
const idxs = p2.map((x) => x.target);
const p1Sub = metrics(idxs.map((i) => p1[i]));
const p2m = metrics(p2);
// 一覧投稿（機会数が増えた・減った）の変化
const oppDelta = { increased: 0, decreased: 0, same: 0 };
p1.forEach((r, i) => {
  const a = g.results[i]?.output?.opportunities.length;
  const b = r.output?.opportunities.length;
  if (a == null || b == null) return;
  oppDelta[b > a ? "increased" : b < a ? "decreased" : "same"]++;
});
const structChange = { unknown_to_specific: 0, specific_to_unknown: 0, specific_changed: 0, same: 0 };
p1.forEach((r, i) => {
  const a = g.results[i]?.output?.structure.kind;
  const b = r.output?.structure.kind;
  if (!a || !b) return;
  if (a === b) structChange.same++;
  else if (a === "unknown") structChange.unknown_to_specific++;
  else if (b === "unknown") structChange.specific_to_unknown++;
  else structChange.specific_changed++;
});
console.log(JSON.stringify({ meta: { promptVersion: h.promptVersion, patchedIndexes: [...new Set(patched)], patchRuns: hFiles.length - 1, excluded: h.excluded, stopped: h.stopped, totalSpentJpy: +h.spentJpy.toFixed(2), calls: h.calls, fetches: h.fetches, fetchLog: { ok: h.fetchLog.filter((f) => f.ok).length, fail: h.fetchLog.filter((f) => !f.ok).length, byCode: by(h.fetchLog, (f) => f.code), byOrigin: by(h.fetchLog.filter((f) => f.ok), (f) => f.origin) } }, baseline10G: base, phase1_inputDesignOnly: imp, structureChange_vs10G: structChange, opportunityCountChange_vs10G: oppDelta, phase2_withFetch_targets: p2.length, phase2_sameTargets_phase1: p1Sub, phase2_result: p2m }, null, 1));
