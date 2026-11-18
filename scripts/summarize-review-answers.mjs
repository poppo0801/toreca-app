// Stage 9F-2: 正誤チェックの評価結果JSONの集計（集計のみ。正解を推測して改善する処理はしない）。
//   node scripts/summarize-review-answers.mjs <review-answers-….json> [--json]
// 正解データに使えるもの（usableAsGold）と、使えないもの（判断できない・未評価・入力不備）を分けて数える。
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("使い方: node scripts/summarize-review-answers.mjs <review-answers.json>");
const a = JSON.parse(readFileSync(file, "utf8"));
if (a.format !== "toremane-review-answers") throw new Error("評価結果のファイルではありません");
const count = (arr, f) => arr.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
const rs = a.results ?? [];
const gold = rs.filter((r) => r.human.usableAsGold);
const out = {
  setId: a.setId,
  total: a.total,
  evaluated: rs.filter((r) => r.human.verdict).length,
  unevaluated: a.total - rs.filter((r) => r.human.verdict).length,
  usableAsGold: gold.length,
  notUsable: { unknown: rs.filter((r) => r.human.verdict === "unknown").length, invalid: rs.filter((r) => r.human.verdict && r.human.verdict !== "unknown" && !r.human.usableAsGold).length },
  byVerdict: count(rs, (r) => r.human.verdict ?? "(未評価)"),
  byCategoryAndVerdict: count(gold, (r) => `${r.category}:${r.human.verdict}`),
  // AIの判断（処理）ごとの正誤。間違っている＝処理判断が違う
  byAiDecision: count(gold, (r) => `${r.aiOriginal?.decision?.status ?? "?"}:${r.human.verdict}`),
  wrongFields: count(gold.flatMap((r) => r.human.corrections), (c) => c.field),
  unknownOnlyFields: count(gold.flatMap((r) => r.human.unknownOnlyFields.map((f) => ({ f }))), (x) => x.f),
  decisionShouldHaveBeen: count(gold.flatMap((r) => r.human.corrections.filter((c) => c.field === "decision")), (c) => c.correctValue || "(未入力)"),
  note: "分母は正解データに使える件数。判断できない・未評価は含めない。件数が少ないため率は目安",
};
console.log(JSON.stringify(out, null, 2));
