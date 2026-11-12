// 評価基盤のCLI（Stage 8D-1）。AIの実接続はしない。使い方は eval/README.md
//   node scripts/eval.mjs validate               入力・正解・資料の整合を検査
//   node scripts/eval.mjs baseline [out.json]    基準線（全件を人手確認に回す）の出力を作る
//   node scripts/eval.mjs score <run.json>       採点（正解と突き合わせ）
//   node scripts/eval.mjs compare <a.json> <b.json>   2つの出力を比較
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { compareScores, loadCases, loadContext, loadCorpus, loadGold, runSystem, scoreRun, trivialAdapter, validateCases, validateGold, validateRun } from "../eval/lib.mjs";

const [cmd, ...args] = process.argv.slice(2);
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const readRun = (p) => JSON.parse(readFileSync(p, "utf8"));

function printScore(s) {
  console.log(`システム: ${s.system} / ケース ${s.cases}`);
  console.log(`1 正確性        決定 ${pct(s.accuracy.decisionAccuracy)} / 項目 ${pct(s.accuracy.fieldAccuracy)}（${s.accuracy.fieldsChecked}項目）`);
  console.log(`2 情報不足の解決 ${pct(s.resolution.resolvedRate)}（${s.resolution.resolvedFields}/${s.resolution.targetFields}項目）`);
  console.log(`3 重複判定      適合率 ${pct(s.dedupe.precision)} / 再現率 ${pct(s.dedupe.recall)} / 誤った重複扱い ${s.dedupe.falseDuplicates}`);
  console.log(`4 人手の修正    推定 ${s.human.estimatedEdits} 操作（1件あたり ${s.human.editsPerCase?.toFixed(2)}）/ 要確認 ${s.human.needsHumanCases} 件（うち不要な要確認 ${s.human.unnecessaryManualCases}）`);
  console.log(`5 処理時間      合計 ${s.time.totalMs}ms / p50 ${s.time.p50Ms}ms / p95 ${s.time.p95Ms}ms`);
  console.log(`6 API           ${s.api.calls} 回 / 推定 ${s.api.estimatedCostJpy} 円`);
  console.log(`7 誤登録・誤更新 誤登録 ${s.errors.wrongRegistrations} / 登録禁止の登録 ${s.errors.forbiddenRegistrations} / 誤更新 ${s.errors.wrongUpdates} / 推測で作った項目 ${s.errors.inventedFields} / 注意の付け忘れ ${s.errors.missingCautions} / 余計なマスター作成 ${s.errors.createdMasters}`);
}

const cases = loadCases();
const context = loadContext();
if (cmd === "validate") {
  const errors = [...validateCases(cases), ...validateGold(loadGold(), cases, context)];
  console.log(`入力 ${cases.length} 件 / 正解 ${loadGold().length} 件 / 資料 ${loadCorpus().length} 件`);
  if (errors.length) { errors.forEach((e) => console.error("NG:", e)); process.exit(1); }
  console.log("OK: 入力に正解の混入なし・正解と入力が1対1・参照先が実在");
} else if (cmd === "baseline") {
  const run = runSystem(trivialAdapter, cases, context, loadCorpus());
  const out = args[0] ?? "eval/runs/baseline-trivial.json";
  mkdirSync("eval/runs", { recursive: true });
  writeFileSync(out, JSON.stringify(run, null, 2) + "\n");
  console.log(`基準線の出力を ${out} に保存しました（全件を人手確認に回す下限）`);
  printScore(scoreRun(run, loadGold()));
} else if (cmd === "score") {
  const run = readRun(args[0]);
  const errors = validateRun(run, cases);
  if (errors.length) { errors.forEach((e) => console.error("NG:", e)); process.exit(1); }
  printScore(scoreRun(run, loadGold()));
} else if (cmd === "compare") {
  const [a, b] = args.map((p) => scoreRun(readRun(p), loadGold()));
  console.log(`A: ${a.system}  →  B: ${b.system}`);
  for (const r of compareScores(a, b)) console.log(`${r.improved === null ? "  " : r.improved ? "↑" : "↓"} ${r.label}: ${r.a ?? "—"} → ${r.b ?? "—"}`);
} else {
  console.error("使い方: node scripts/eval.mjs validate | baseline [out] | score <run.json> | compare <a.json> <b.json>");
  process.exit(1);
}
