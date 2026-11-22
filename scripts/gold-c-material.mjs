// 条件C の独立した正解（gold）の確認資料（ローカル限定・読み取りのみ・外部通信なし）。10Sの人の回答を、独立した正解にできるかで分類して表示する。
//   node scripts/gold-c-material.mjs
// 出力: eval/real-data/gold-c-material.json と gold-c-material.html（Git管理外）。回答を書き換えない・AIに渡さない。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { classifyGold } from "./lib/gold-c.mjs";
import { currentOf } from "./lib/groundtruth.mjs";

const DIR = "eval/real-data";
const REVIEW = `${DIR}/human-review-10s.json`;
const ANSWERS = `${DIR}/human-review-10s-answers.json`;
if (!existsSync(REVIEW) || !existsSync(ANSWERS)) {
  console.error("10Sの確認資料・回答が見つかりません（再度の質問はしません。条件Cは実例不足として扱う）");
  process.exit(1);
}
const cases = JSON.parse(readFileSync(REVIEW, "utf8")).cases;
const store = JSON.parse(readFileSync(ANSWERS, "utf8"));
const g = classifyGold(cases, store, currentOf);
mkdirSync(DIR, { recursive: true });
writeFileSync(`${DIR}/gold-c-material.json`, JSON.stringify({ counts: g.counts, goldCount: g.goldCount, rateAllowed: g.rateAllowed, rows: g.rows }, null, 1));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const LABEL = { gold: "独立した正解（gold）", human_unit_no_basis: "正しい方式の明示あり・根拠の記録なし（要確認）", evaluation_of_prior_only: "以前のAIへの評価のみ（正解ラベルなし）", undecidable: "判断不能・方式未指定", pending: "未回答" };
const html = `<!doctype html><meta charset="utf-8"><title>条件C: 正解データの確認資料</title><style>body{font:14px/1.6 system-ui;max-width:900px;margin:0 auto;padding:12px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px 6px;text-align:left}.g{background:#e6f6e6}.w{background:#fff3cd}</style>
<h2>条件C: 独立した正解（gold）の確認資料（ローカル専用）</h2>
<p>10Sの回答は「以前のAIの判断への評価」です。<b>独立した正解（gold）</b>にできるのは、人が正しい応募方式を明示し、根拠の記録（メモ）がある事例だけです。「根拠の記録なし」の事例は、根拠をひとこと書き足せば gold にできます（再度の全件回答は不要）。</p>
<p>件数: ${Object.entries(g.counts).map(([k, v]) => `${esc(LABEL[k])} ${v}`).join(" ／ ")}。正答率を出せる最小の gold 数: ${g.minForRate}（現在 ${g.goldCount}）。</p>
<table><tr><th>ID</th><th>分類</th><th>正しい方式（人）</th><th>根拠の記録</th><th>理由</th><th>以前のAIの方式</th></tr>
${g.rows.map((r) => `<tr class="${r.category === "gold" ? "g" : r.category === "human_unit_no_basis" ? "w" : ""}"><td>${esc(r.id)}</td><td>${esc(LABEL[r.category])}</td><td>${esc(r.gold?.unit ?? "—")}</td><td>${esc(r.gold?.basis ?? "—")}</td><td>${esc(r.why)}</td><td>${esc(r.priorAiUnit ?? "—")}</td></tr>`).join("")}</table>`;
writeFileSync(`${DIR}/gold-c-material.html`, html);
console.log(JSON.stringify({ counts: g.counts, goldCount: g.goldCount, rateAllowed: g.rateAllowed }));
