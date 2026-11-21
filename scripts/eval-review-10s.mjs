// Stage 10S: 人の確認結果だけから評価する（応募単位・選択時点の一致率、誤統合・誤分割、false auto-register）。回答が無ければ「未測定」。
//   node scripts/eval-review-10s.mjs
// AIの判断・機械検査の一致は正解に算入しない。架空ケースは含めない。
import { existsSync, readFileSync } from "node:fs";
import { evaluate } from "./lib/groundtruth.mjs";

const DIR = "eval/real-data";
if (!existsSync(`${DIR}/human-review-10s.json`)) {
  console.error("確認用のデータがありません");
  process.exit(1);
}
const cases = JSON.parse(readFileSync(`${DIR}/human-review-10s.json`, "utf8")).cases;
const store = existsSync(`${DIR}/human-review-10s-answers.json`) ? JSON.parse(readFileSync(`${DIR}/human-review-10s-answers.json`, "utf8")) : { cases: {} };
console.log(JSON.stringify(evaluate(cases, store), null, 2));
