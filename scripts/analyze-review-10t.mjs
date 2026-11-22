// Stage 10T: Stage 10S の人の回答30件を、「情報不足」と「AIの誤判定」に分けて集計する（人の回答だけが正解。AIの仮説で置き換えない）。
//   node scripts/analyze-review-10t.mjs
// 区分（ルールは固定の判定ではなく、回答時点で記録された事実だけを使う）:
//   評価対象外: 判断不能（人がURL等を確認できなかった）／未回答。正解率の母数に入れない。
//   一致: 人が「正しい」とした。
//   誤り・根拠なしの断定: 人が「誤り」で、AIの直接の根拠が無い（AIの仮説が情報不足のまま主張された）。
//   誤り・根拠ありで外れ: 人が「誤り」で、AIが直接の根拠を持っていた（解釈の誤りの可能性が高い）。
import { existsSync, readFileSync } from "node:fs";
import { currentOf } from "./lib/groundtruth.mjs";

const DIR = "eval/real-data";
const cases = JSON.parse(readFileSync(`${DIR}/human-review-10s.json`, "utf8")).cases;
const store = existsSync(`${DIR}/human-review-10s-answers.json`) ? JSON.parse(readFileSync(`${DIR}/human-review-10s-answers.json`, "utf8")) : { cases: {} };
const count = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

const rows = cases.map((c, i) => {
  const cur = currentOf(store, c.id);
  let cls;
  if (!cur) cls = "未回答";
  else if (cur.verdict === "undecidable") cls = "判断不能（評価対象外）";
  else if (cur.verdict === "correct") cls = "一致";
  else if (c.aiUnit === "unknown") cls = "AIは不明と回答（誤判定ではなく未解決）";
  else cls = c.directEvidence ? "誤り・直接の根拠ありで外れ" : "誤り・直接の根拠なしの断定";
  return { no: i + 1, set: c.id.startsWith("r10:") ? "既存の一覧項目" : "新しい公開ページ", cls, aiUnit: c.aiUnit, humanUnit: cur?.correctUnit ?? null, scope: c.scope?.verdict ?? null, note: !!cur?.note };
});
const bySet = {};
for (const s of ["既存の一覧項目", "新しい公開ページ"]) bySet[s] = count(rows.filter((r) => r.set === s).map((r) => r.cls));
const wrong = rows.filter((r) => r.cls.startsWith("誤り") || r.cls.startsWith("AIは不明"));
console.log(
  JSON.stringify(
    {
      total: rows.length,
      bySet,
      wrongDetail: wrong.map((r) => ({ no: r.no, ai: r.aiUnit, human: r.humanUnit, pageScope: r.scope, reason: r.cls, humanNote: r.note })),
      wrongByPageScope: count(wrong.map((r) => r.scope ?? "none")),
      wrongPairs: count(wrong.map((r) => `${r.aiUnit}→${r.humanUnit}`)),
      undecidableWithoutNote: rows.filter((r) => r.cls.startsWith("判断不能") && !r.note).length,
      note: "判断不能の理由は回答に記録されていない（メモ無し）。確認資料に応募ページのURLが含まれていなかったことが、判断不能の主因と考えられる（要・本人の確認）",
    },
    null,
    2,
  ),
);
