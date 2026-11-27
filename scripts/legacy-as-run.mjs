// CAPABILITY_CEILING §4: 現行方式（旧方式）の保存済みの結果を、評価の記録と同じ形にする（無課金・ローカルのファイルだけ）。
//   node scripts/legacy-as-run.mjs [--run=legacy]  → eval/intensive/runs/<run>.local.jsonl（intensive-score.mjs で同じ正解・同じ基準で採点できる）
// 現行の結果を正解として扱わない（比較の対象）。旧方式は候補ごとに下書き1件（複数の機会は1件にまとまる）なので、その制約もそのまま採点に出る。
// 対応: auto_registered→登録／excluded→除外／duplicate→登録（既存の抽選と同じと判断＝機会は登録済み）／pending・failed→保留
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const run = arg("run") ?? "legacy";
const DIR = "eval/intensive";
const rows = [];
for (const f of ["cases.local.json", "cases.new1127.local.json"]) {
  if (!existsSync(`${DIR}/${f}`)) continue;
  const j = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
  rows.push(...(j.rows ?? j.cases ?? []));
}
const sel = JSON.parse(readFileSync(`${DIR}/selection.local.json`, "utf8")).cases;
const byId = new Map(rows.map((r) => [r.id.slice(0, 8), r]));
const dt = (x) => (x?.date ? `${x.date}${x.time ? " " + x.time : ""}` : null);
const F = (v) => (v === null || v === undefined || String(v).trim() === "" ? undefined : { value: String(v), basis: "observed" });
const out = [];
for (const s of sel) {
  const r = byId.get(s.caseId);
  if (!r) continue;
  const d = r.legacy?.draft?.input ?? null;
  const decision = r.status === "auto_registered" || r.status === "duplicate" ? "register" : r.status === "excluded" ? "exclude" : "tentative";
  const fields = {};
  if (d) {
    const put = (k, v) => { const x = F(v); if (x) fields[k] = x; };
    put("store", [d.chain?.name, d.store?.name].filter(Boolean).join(" "));
    put("store_location", d.store?.prefecture);
    put("product", (d.items ?? []).map((i) => i.product?.name).filter(Boolean).join(" / "));
    put("apply_start", dt(d.applyStart));
    put("deadline", dt(d.applyDeadline));
    put("result_at", dt(d.resultDate));
    put("purchase_start", dt(d.procedureStart));
    put("purchase_end", dt(d.procedureEnd));
    put("apply_method", d.applyMethod);
    put("receive_method", d.receiveMethod);
    put("per_person_limit", d.limitMaxCount);
    put("conditions", d.conditionsText);
    put("price", (d.items ?? []).map((i) => i.price).find((p) => p));
  }
  out.push({ run, judgeMode: "legacy", agentModel: "legacy", at: r.createdAt ?? null, caseId: s.caseId, set: s.set, ok: true, reason: null, costJpy: 0, ms: 0, records: [{ itemNo: 1, itemLabel: r.title ?? "", decision, verified: true, heldReasons: [], fields, judgeTrail: null, unknowns: [] }], legacyStatus: r.status });
}
writeFileSync(`${DIR}/runs/${run}.local.jsonl`, out.map((x) => JSON.stringify(x)).join("\n") + "\n");
console.log(JSON.stringify({ run, cases: out.length }));
