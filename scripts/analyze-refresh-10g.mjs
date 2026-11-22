// Stage 10G: 再判定結果（eval/real-data/refresh-10g-*.json。ローカル）の集計。**オフライン。標準出力は件数・統計のみ**（原文・URL・ID・店舗名は出さない）。
//   node scripts/analyze-refresh-10g.mjs
import { readdirSync, readFileSync } from "node:fs";

const dir = "eval/real-data";
const f = readdirSync(dir).filter((x) => x.startsWith("refresh-10g-")).sort().at(-1);
const d = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　・･\-－ー()（）]/g, "");
const by = (arr, k) => arr.reduce((m, x) => ((m[k(x)] = (m[k(x)] ?? 0) + 1), m), {});
const R = d.results;
const out = R.filter((r) => r.output);
const struct = (r) => r.output.structure.kind;

const stats = {
  file: "(local)",
  selected: d.selected,
  sent: R.length,
  excluded: d.excluded,
  stoppedBy: d.stoppedBy,
  spentJpy: Math.round(d.spentJpy * 100) / 100,
  calls: d.calls,
  status: by(R, (r) => r.status),
  attempts: by(R, (r) => r.attempts),
  byKind: by(R, (r) => r.kind),
  latencyMs: (() => { const l = R.map((r) => r.latencyMs).sort((a, b) => a - b); return { avg: Math.round(l.reduce((a, b) => a + b, 0) / l.length), median: l[l.length >> 1], max: l.at(-1) }; })(),
  costPerCase: (() => { const c = R.map((r) => r.costJpy).sort((a, b) => a - b); return { min: +c[0].toFixed(2), median: +c[c.length >> 1].toFixed(2), max: +c.at(-1).toFixed(2) }; })(),
  structure: by(out, struct),
  structureByKind: by(out, (r) => `${r.kind}:${struct(r)}`),
  caseType: by(out, (r) => r.output.caseType.value),
  opportunityCount: by(out, (r) => r.output.opportunities.length),
  unresolvedCount: by(out, (r) => r.output.unresolved.length),
  unresolvedImportance: by(out.flatMap((r) => r.output.unresolved), (u) => u.importance),
  nextActions: by(out.flatMap((r) => r.output.nextActions), (a) => a.kind),
  textChars: (() => { const c = R.map((r) => r.textChars).sort((a, b) => a - b); return { min: c[0], median: c[c.length >> 1], max: c.at(-1) }; })(),
};

// unknown 構造・保留の分類（機械的な目安。原文の個別確認ではない）
const cls = (r) => {
  const o = r.output;
  const t = o.caseType.value;
  if (t === "not_lottery") return "b_not_lottery";
  if (t === "result_announcement" || t === "update") return "b_other_type(result/update)";
  const dl = o.opportunities.some((p) => p.applyDeadline && p.applyDeadline.value);
  if (r.textChars < 120) return "a_text_too_short";
  if (!dl) return "a_no_deadline_in_text";
  const imp = o.unresolved.map((u) => u.importance);
  if (!imp.includes("high") && !imp.includes("medium")) return "d_possible_over_hold(all_low)";
  return "e_other(needs_reading)";
};
stats.unknownStructure = { n: out.filter((r) => struct(r) === "unknown").length, byCause: by(out.filter((r) => struct(r) === "unknown"), cls) };
stats.holdsWithHighOrMedium = out.filter((r) => r.output.unresolved.some((u) => u.importance !== "low")).length;
stats.holdsOnlyLow = out.filter((r) => r.output.unresolved.length > 0 && r.output.unresolved.every((u) => u.importance === "low")).length;
stats.holdsAll = out.filter((r) => r.output.unresolved.length > 0).length;
stats.zeroOpportunities = out.filter((r) => r.output.opportunities.length === 0).length;

// 既存の登録値との比較（比較できる項目のみ）
const cmp = { chain: { equal: 0, differ: 0, notComparable: 0 }, store: { equal: 0, differ: 0, notComparable: 0 }, deadline: { equal: 0, differ: 0, notComparable: 0 }, products: { overlap: 0, noOverlap: 0, notComparable: 0 }, structureVsStoreMode: { consistent: 0, inconsistent: 0, notComparable: 0 }, selfRelation: {}, neighborSame: 0, neighborIndependent: 0, neighborUnknown: 0 };
const claim = (p, k) => (p && p[k] && p[k].value && p[k].basis !== "unknown" ? p[k].value : null);
for (const r of out) {
  const o = r.output;
  const e = r.existing;
  const p = o.opportunities[0];
  const c = claim(p, "chain");
  c == null || !e.chain ? cmp.chain.notComparable++ : norm(c).includes(norm(e.chain)) || norm(e.chain).includes(norm(c)) ? cmp.chain.equal++ : cmp.chain.differ++;
  const s = claim(p, "store");
  s == null || !e.store ? cmp.store.notComparable++ : norm(s).includes(norm(e.store)) || norm(e.store).includes(norm(s)) ? cmp.store.equal++ : cmp.store.differ++;
  const dls = o.opportunities.map((x) => claim(x, "applyDeadline")).filter(Boolean);
  dls.length === 0 || !e.applyDeadline ? cmp.deadline.notComparable++ : dls.some((x) => String(x).includes(e.applyDeadline)) ? cmp.deadline.equal++ : cmp.deadline.differ++;
  const pr = o.opportunities.flatMap((x) => claim(x, "products") ?? []);
  pr.length === 0 || !e.products.length ? cmp.products.notComparable++ : pr.some((x) => e.products.some((y) => norm(x).includes(norm(y)) || norm(y).includes(norm(x)))) ? cmp.products.overlap++ : cmp.products.noOverlap++;
  const k = struct(r);
  if (k === "unknown") cmp.structureVsStoreMode.notComparable++;
  else if (e.storeMode === "select_on_apply") (k === "store_select" ? cmp.structureVsStoreMode.consistent++ : cmp.structureVsStoreMode.inconsistent++);
  else (k === "store_select" ? cmp.structureVsStoreMode.inconsistent++ : cmp.structureVsStoreMode.consistent++);
  const self = o.relations.filter((x) => x.lotteryId === "R1").map((x) => x.relation);
  const sr = self.length ? self[0] : "none";
  cmp.selfRelation[sr] = (cmp.selfRelation[sr] ?? 0) + 1;
  for (const x of o.relations.filter((x) => /^N\d$/.test(x.lotteryId))) {
    if (x.relation === "same") cmp.neighborSame++;
    else if (x.relation === "independent") cmp.neighborIndependent++;
    else cmp.neighborUnknown++;
  }
}
stats.comparison = cmp;
stats.plannedChanges = by(out.flatMap((r) => r.output.plannedChanges), (c) => c.op);
stats.plannedOnProtected = out.filter((r) => r.protection === "protected").reduce((n, r) => n + r.output.plannedChanges.length, 0);
stats.violationCodes = by(R.flatMap((r) => r.violationCodes), (c) => c);
console.log(JSON.stringify(stats, null, 1));
