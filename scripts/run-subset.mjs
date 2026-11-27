// CAPABILITY_CEILING §4: ある実行（--like）と同じ案件だけを、別の記録（--from）から切り出す（無課金。現行方式との同一案件の比較用）
//   node scripts/run-subset.mjs --from=legacy --like=e2h --to=legacy-e2h
import { readFileSync, writeFileSync } from "node:fs";
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const R = (r) => readFileSync(`eval/intensive/runs/${r}.local.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ids = new Set(R(arg("like")).map((l) => l.caseId));
const rows = R(arg("from")).filter((l) => ids.has(l.caseId));
writeFileSync(`eval/intensive/runs/${arg("to")}.local.jsonl`, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
console.log(JSON.stringify({ to: arg("to"), cases: rows.length, of: ids.size }));
