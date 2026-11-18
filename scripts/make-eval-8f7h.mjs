// 8F-7: 形態シナリオ（架空・H01〜H11）を、実API評価の枠組み（組 8f7h）の入力・正解に変換する。
// 正解ラベルは gold-8f6.json（定義の文言だけから決めたもの）をそのまま使う。AIの出力は見ない。実データではなく架空データ（synthetic）。
import { readFileSync, writeFileSync } from "node:fs";

const sc = JSON.parse(readFileSync("eval/lottery-grouping/scenarios-8f6.json", "utf8")).scenarios;
const gold = JSON.parse(readFileSync("eval/lottery-grouping/gold-8f6.json", "utf8")).labels;
const category = (id) => ({ H06: "conditions_differ", H07: "period_differs", H10: "insufficient", H11: "insufficient" })[id] ?? "multi_store_same";
const cases = sc.map((s) => ({ ...s, category: category(s.id), capturedAt: "2026-11-13T00:00:00Z", sources: [{ url: `https://example.invalid/synthetic/${s.id}`, fetchedAt: "2026-11-13T00:00:00Z" }] }));
const labels = {};
for (const s of sc) labels[s.id] = { label: gold[s.id].label, basis: [{ kind: "human_review", ref: "synthetic:definition-8f6(gold-8f6.json)", checkedAt: "2026-11-13" }], note: gold[s.id].why };
writeFileSync("eval/lottery-grouping-real/cases-8f7h.json", JSON.stringify({ version: 1, kind: "synthetic", note: "架空データ（実データではない）。scenarios-8f6.json から変換", cases }, null, 1) + "\n");
writeFileSync("eval/lottery-grouping-real/gold-8f7h.json", JSON.stringify({ version: 1, kind: "synthetic", labels }, null, 1) + "\n");
console.log("cases:", cases.length);
