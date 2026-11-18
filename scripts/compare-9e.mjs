// Stage 9E: 評価の比較表（読み取りのみ）。複数の実行ラベルの指標を並べる。
//   node scripts/compare-9e.mjs baseline-fixed-v1 real-r1 real-r2 [--json out.json]
// 除外（eval/investigation-9e/exclusions.json＝評価側の不具合）は、除外前・除外後を両方示す。
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const D = "eval/runs/investigation-9e";
const labels = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
const excl = JSON.parse(readFileSync("eval/investigation-9e/exclusions.json", "utf8")).exclusions;
const gold = JSON.parse(readFileSync("eval/investigation-9e/gold-scenarios.json", "utf8"));
const isExcludedFor = (label) => (sc, url) => excl.some((e) => e.scenario === sc && (!e.labels || e.labels.includes(label)) && (url === e.url || `${url}/` === e.url || url === `${e.url}/`));
const goldUrl = (u) => gold.urls[u] || gold.urls[`${u}/`] || gold.urls[u.replace(/\/$/, "")];

const rows = [];
for (const label of labels) {
  const sumFile = `${D}/${label}-summary.json`;
  if (!existsSync(sumFile)) continue;
  const s = JSON.parse(readFileSync(sumFile, "utf8"));
  const recFile = `${D}/${label}-records.json`;
  const recs = existsSync(recFile) ? JSON.parse(readFileSync(recFile, "utf8")) : [];
  const isExcluded = isExcludedFor(label);
  const n = s.results.length;
  const sum = (f) => s.results.reduce((a, r) => a + f(r.score), 0);
  let aiTotal = 0;
  let aiOk = 0;
  let aiTotalAdj = 0;
  let aiOkAdj = 0;
  for (const r of s.results)
    for (const a of r.score.aiActions ?? []) {
      if (a.ok === null) continue;
      aiTotal += 1;
      if (a.ok) aiOk += 1;
      if (!isExcluded(r.score.scenario, a.url)) {
        aiTotalAdj += 1;
        if (a.ok) aiOkAdj += 1;
      }
    }
  // 無駄・拒否された呼び出し（取得上限・未取得・重複・解析上限）
  let refused = 0;
  let steps = 0;
  let aiSteps = 0;
  let reviewSteps = 0;
  let followUps = 0;
  for (const r of recs) {
    for (const st of r.record.steps) {
      steps += 1;
      if (!st.ok && /上限|未取得|重複|同じ|載っているリンクではありません/.test(st.resultSummary)) refused += 1;
      if (st.decidedBy === "ai") aiSteps += 1;
      if (st.decidedBy === "review_feedback") reviewSteps += 1;
    }
    followUps += r.record.followUps ?? 0;
  }
  rows.push({
    label,
    real: s.real,
    runs: n,
    misRegistrations: sum((c) => c.misRegistrations.length),
    nonLotteryRecognized: sum((c) => c.nonLotteryRecognized.length),
    findLotteryOk: (() => {
      let ok = 0;
      for (const r of s.results) {
        const rec = recs.find((x) => x.scenario === r.scenario && x.run === r.run)?.record;
        const ident = !!rec && (rec.review?.accepted.findings ?? []).some((f) => f.kind === "lottery_info" && f.url && ["lottery_announcement", "past_lottery"].includes(f.pageKind) && goldUrl(f.url.replace(/#.*$/, "")));
        const shouldFind = gold.scenarios[r.scenario].shouldFindLottery;
        if (shouldFind ? r.score.findLotteryOk || ident : r.score.findLotteryOk) ok += 1;
      }
      return `${ok}/${n}`;
    })(),
    aiActionRaw: aiTotal ? `${aiOk}/${aiTotal}` : "-",
    aiActionAdjusted: aiTotalAdj ? `${aiOkAdj}/${aiTotalAdj}` : "-",
    fixedDispositionOk: (() => {
      let t = 0;
      let o = 0;
      for (const r of s.results) for (const p of r.score.perUrl) if (p.dispositionOk !== null && !isExcluded(r.score.scenario, p.url)) (t += 1), p.dispositionOk && (o += 1);
      return t ? `${o}/${t}` : "-";
    })(),
    stepsTotal: steps,
    refusedCalls: refused,
    aiDecidedSteps: aiSteps,
    reviewFeedbackSteps: reviewSteps,
    followUps,
    costJpy: Math.round(sum((c) => c.costJpy) * 100) / 100,
    avgCostJpy: n ? Math.round((sum((c) => c.costJpy) / n) * 100) / 100 : 0,
    avgSec: n ? Math.round(sum((c) => c.ms) / n / 100) / 10 : 0,
    stopped: s.stopped,
  });
}
console.table(rows);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
