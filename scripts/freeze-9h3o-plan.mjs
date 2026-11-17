// Stage 9H-3O: 系列横断の実調査の対象を凍結する（費用0・読み取りのみ）。結果を見て差し替えない。
//   前提: BUILD_9H3O=1 で src/lib/collector/sweep-plan-9h3o.test.ts を実行し、backups/eval-9h3o/sweep-plan.json・controls.json がある。
//   選定規則（系列を優遇しない）: 調査計画（planSweep）が選んだ対象を (系列, 店舗) で重複除去し、同じ系列は最大4件。店舗でない名称（「店舗未確認」・特設コーナー）は除く。
//   対照: 計画が選ばなかった（その系列の複数店舗の開催機会に過去1件も参加していない）店舗を、系列ごとに1件、最大2系列。
import { readFileSync, writeFileSync } from "node:fs";

const plan = JSON.parse(readFileSync("backups/eval-9h3o/sweep-plan.json", "utf8"));
const controls = JSON.parse(readFileSync("backups/eval-9h3o/controls.json", "utf8"));
const NOT_STORE = /店舗未確認|特設コーナー|レジ/;
const cases = [];
const seen = new Set();
const perChain = {};
for (const s of plan.seeds) {
  for (const t of s.targets) {
    if (NOT_STORE.test(t.store)) continue;
    const key = `${t.chain}|${t.store.replace(/^キデイランド\s*/, "")}`;
    if (seen.has(key)) continue;
    if ((perChain[t.chain] ?? 0) >= 4) continue;
    seen.add(key);
    perChain[t.chain] = (perChain[t.chain] ?? 0) + 1;
    cases.push({
      caseId: `sw-${String(cases.length + 1).padStart(2, "0")}`,
      kind: "planned",
      chain: t.chain,
      store: t.store,
      product: s.product,
      seed: { store: s.seedStore, url: s.seedUrl, applyStart: s.applyStart, applyDeadline: s.applyDeadline, knownStores: s.stores },
      probability: t.probability,
      confidence: t.confidence,
      reasons: t.reasons,
    });
  }
}
const ctrlChains = new Set();
for (const c of controls) {
  if (ctrlChains.has(c.chain) || ctrlChains.size >= 2) continue;
  const seedRow = plan.seeds.find((s) => s.chain === c.chain && s.product === c.product);
  if (!seedRow) continue;
  ctrlChains.add(c.chain);
  cases.push({
    caseId: `sw-${String(cases.length + 1).padStart(2, "0")}`,
    kind: "control",
    chain: c.chain,
    store: c.store,
    product: c.product,
    seed: { store: seedRow.seedStore, url: seedRow.seedUrl, applyStart: seedRow.applyStart, applyDeadline: seedRow.applyDeadline, knownStores: seedRow.stores },
    probability: null,
    confidence: null,
    reasons: [`対照: この店舗は、系列の複数店舗の開催機会${c.chainMultiStoreOpportunities}件のどれにも過去に参加していない（計画は選ばなかった）`],
  });
}
const digest = Buffer.from(JSON.stringify(cases.map((c) => [c.chain, c.store, c.product]))).toString("base64").slice(0, 16);
writeFileSync("backups/eval-9h3o/plan.json", JSON.stringify({ frozenAt: new Date().toISOString(), basedOn: plan.at, digest, cases }, null, 1));
for (const c of cases) console.log(c.caseId, c.kind, c.chain, c.store, "|", c.product.slice(0, 28), "|", c.probability);
console.log(`対象 ${cases.length}件 digest ${digest}`);
