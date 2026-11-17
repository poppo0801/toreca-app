// 9H-3O: 保存された1件の実調査の過程を読みやすく表示する（読み取りのみ）。node scripts/show-9h3o-case.mjs sw-01
import { readdirSync, readFileSync, existsSync } from "node:fs";
const id = process.argv[2];
const runs = readdirSync("backups/eval-9h3o/runs").sort();
const f = runs.map((r) => `backups/eval-9h3o/runs/${r}/case-${id}.json`).filter(existsSync).pop();
const j = JSON.parse(readFileSync(f, "utf8"));
const r = j.result;
console.log(`${j.caseId} ${j.kind} ${j.plan.chain} ${j.plan.store} | ${j.plan.product} | 費用 ${j.costJpy}円 | stop=${r?.stopReason} ${r?.stopLabel}`);
console.log("AI終了:", JSON.stringify(r?.aiFinish));
console.log("検索語:", JSON.stringify(r?.queries));
console.log("取得:", JSON.stringify(r?.fetched));
for (const s of r?.steps ?? []) console.log(` step ${s.n ?? ""} ${s.tool ?? s.kind ?? ""} ok=${s.ok} ${String(s.resultSummary ?? "").slice(0, 160)}`);
console.log("項目:");
for (const x of r?.fields ?? []) if (x.adopted || x.alternatives?.length) console.log(` ${x.field} [${x.state}] ${String(x.adopted).slice(0, 80)} ← ${x.sources.map((s) => s.url).join(", ").slice(0, 140)}`);
console.log("情報源:");
for (const s of r?.sources ?? []) console.log(` ${s.status} ${s.kind}/${s.tier} ${s.url} id=${JSON.stringify(s.identity ?? null).slice(0, 220)}`);
console.log("統合しなかった:", JSON.stringify(r?.notMerged));
console.log("方針の変更:", JSON.stringify(r?.policyChanges).slice(0, 400));
