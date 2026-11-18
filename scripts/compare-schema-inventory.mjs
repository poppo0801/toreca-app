// Stage Release-1: スキーマの棚卸し2つの差分（オフライン・読み取りだけ）。
//   node scripts/compare-schema-inventory.mjs <A.json> <B.json>
// A にあって B に無い（A のみ）／B にあって A に無い（B のみ）／同じ名前で定義が違う（変更）を、種類ごとに表示する。
import { readFileSync } from "node:fs";

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, "utf8")));
if (!a || !b) throw new Error("使い方: node scripts/compare-schema-inventory.mjs <A.json> <B.json>");
console.log(`A: ${a.target} ${a.at}   B: ${b.target} ${b.at}`);
const ver = (x) => x.migrations.map((m) => m.version);
console.log(`適用履歴 A: ${ver(a).length}件（最新 ${ver(a).at(-1)}） / B: ${ver(b).length}件（最新 ${ver(b).at(-1)}）`);
console.log(`  履歴のAのみ: ${ver(a).filter((v) => !ver(b).includes(v)).join(", ") || "なし"}`);
console.log(`  履歴のBのみ: ${ver(b).filter((v) => !ver(a).includes(v)).join(", ") || "なし"}`);
let total = 0;
for (const kind of ["tables", "columns", "functions", "triggers", "policies", "rls", "constraints", "indexes", "views"]) {
  const keyOf = (s) => (kind === "tables" ? s : s.split(":")[0]);
  const ma = new Map(a[kind].map((s) => [keyOf(s), s]));
  const mb = new Map(b[kind].map((s) => [keyOf(s), s]));
  const onlyA = [...ma.keys()].filter((k) => !mb.has(k));
  const onlyB = [...mb.keys()].filter((k) => !ma.has(k));
  const changed = [...ma.keys()].filter((k) => mb.has(k) && ma.get(k) !== mb.get(k));
  total += onlyA.length + onlyB.length + changed.length;
  console.log(`\n== ${kind}: Aのみ ${onlyA.length} / Bのみ ${onlyB.length} / 変更 ${changed.length}`);
  for (const [label, list] of [["Aのみ", onlyA], ["Bのみ", onlyB], ["変更", changed]]) for (const k of list.slice(0, 80)) console.log(`   ${label}: ${k}`);
  for (const [label, list] of [["Aのみ", onlyA], ["Bのみ", onlyB], ["変更", changed]]) if (list.length > 80) console.log(`   ${label}: …ほか${list.length - 80}件`);
}
console.log(`\n差分の合計: ${total}件`);
