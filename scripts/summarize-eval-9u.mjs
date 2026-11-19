// Stage 9U: 評価結果（backups/eval-9u/runs）の集計。実AIは呼ばない。
//   node scripts/summarize-eval-9u.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const OUT = "backups/eval-9u";
const runs = readdirSync(`${OUT}/runs`);
const rows = [];
for (const r of runs) for (const f of readdirSync(`${OUT}/runs/${r}`).filter((x) => /^(A|B|B2|F)-mission-\d+\.json$/.test(x))) rows.push(JSON.parse(readFileSync(`${OUT}/runs/${r}/${f}`, "utf8")));
const arms = {};
for (const x of rows) {
  const a = (arms[x.arm] ??= { missions: 0, costJpy: 0, ms: 0, adopt: 0, hold: 0, exclude: 0, aiNew: 0, alreadyKnown: 0, errors: 0, searches: 0, fetches: 0, withNext: 0, withRevisit: 0, leads: [] });
  const rec = x.record;
  a.missions++;
  a.costJpy += x.costJpy;
  a.ms += x.ms;
  if (x.error || !rec) { a.errors++; continue; }
  a.adopt += rec.counts.adopt; a.hold += rec.counts.hold; a.exclude += rec.counts.exclude; a.aiNew += rec.counts.aiNew; a.alreadyKnown += rec.counts.alreadyKnown;
  a.searches += rec.usage.searches; a.fetches += rec.usage.fetches;
  if ((rec.nextMissions ?? []).length) a.withNext++;
  if (rec.revisitHours != null) a.withRevisit++;
  for (const l of rec.leads) a.leads.push({ mission: x.mission, id: x.m.id, chain: l.lead.chain, store: l.lead.store ?? null, products: l.lead.products, status: l.decision.status, credit: l.decision.credit, exclusion: l.decision.exclusion ?? null, region: l.decision.region.verdict, url: l.lead.url, quote: l.lead.quote.slice(0, 100), reason: l.decision.reason.slice(0, 100) });
}
for (const a of Object.values(arms)) { a.costJpy = Math.round(a.costJpy * 100) / 100; a.avgSec = a.missions ? Math.round(a.ms / a.missions / 1000) : 0; }
const ledger = existsSync(`${OUT}/ledger.json`) ? JSON.parse(readFileSync(`${OUT}/ledger.json`, "utf8")).spentJpy : null;
writeFileSync(`${OUT}/summary-all.json`, JSON.stringify({ ledgerSpentJpy: ledger, arms }, null, 1));
for (const [k, a] of Object.entries(arms)) console.log(k, JSON.stringify({ ...a, leads: undefined }));
console.log("ledger", ledger);
