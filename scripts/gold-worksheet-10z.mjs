// Stage 10Z: 独立 gold を増やすための、人のレビュー用ワークシートを作る（**読み取り専用**。回答は書き込まない。AIの旧出力・検証通過を正解扱いしない）。
//   node scripts/gold-worksheet-10z.mjs            → eval/real-data/gold-worksheet-10z.md（Git管理外。原文を含むのでGitに入れない）
// 対象: 人が正しい応募方式を明示したが根拠の記録が無い事例（human_unit_no_basis）。利用者が 元の原文・公開ページ・出典 を確認し、根拠のメモ（6文字以上）を既存の回答の手順で追記すると gold になる。
// 手順（利用者の作業）: ①下のワークシートの各事例で、原文と応募ページを見て応募方式が正しいか確認 ②正しければ、確認した根拠（どのページ・どの記載か）を回答のメモに書く（既存のレビュー画面／回答の保存手順）
//   ③ `node scripts/gold-worksheet-10z.mjs` を再実行して、gold の件数を確認。**gold が10件に達するまで、正答率は出さない**。AIは回答を書き換えない。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { classifyGold } from "./lib/gold-c.mjs";
import { currentOf } from "./lib/groundtruth.mjs";

const REVIEW = "eval/real-data/human-review-10s.json";
const ANSWERS = "eval/real-data/human-review-10s-answers.json";
if (!existsSync(REVIEW) || !existsSync(ANSWERS)) {
  console.log("ローカルの10Sレビュー資料（eval/real-data/）が無いため、ワークシートは作れません");
  process.exit(0);
}
const cases = JSON.parse(readFileSync(REVIEW, "utf8")).cases;
const gold = classifyGold(cases, JSON.parse(readFileSync(ANSWERS, "utf8")), currentOf);
const byId = new Map(cases.map((c) => [c.id, c]));
const out = [`# Stage 10Z gold ワークシート（ローカル限定・Git管理外）`, ``, `現在: gold ${gold.counts.gold} 件／根拠メモなし ${gold.counts.human_unit_no_basis} 件／以前のAIへの評価のみ ${gold.counts.evaluation_of_prior_only} 件／判断不能 ${gold.counts.undecidable} 件／未回答 ${gold.counts.pending} 件。正答率に必要な gold は ${gold.minForRate} 件（現在 ${gold.rateAllowed ? "達成" : "未達"}）。`, ``];
let n = 0;
for (const r of gold.rows.filter((x) => x.category === "human_unit_no_basis")) {
  const c = byId.get(r.id);
  n++;
  out.push(`## ${n}. ${r.id}`, `- 人が指定した正しい応募方式: ${r.gold?.unit ?? "?"}（根拠のメモ: なし → gold にならない）`, `- 以前のAIの応募単位（参考。正解ではない）: ${r.priorAiUnit ?? "—"}`, `- 元の文言:`, ...(c?.sourceText ?? []).map((t) => `  > ${String(t).replace(/\n/g, " ").slice(0, 400)}`), `- 確認すること: 元の原文・応募ページ・出典で、この応募方式が正しいかを確かめ、**どのページのどの記載で確認したか**を回答のメモ（6文字以上）に書く`, ``);
}
if (!n) out.push("根拠メモなしの事例はありません。");
writeFileSync("eval/real-data/gold-worksheet-10z.md", out.join("\n"));
console.log(`ワークシートを書き出しました（根拠メモなし ${n} 件）。gold ${gold.counts.gold}/${gold.minForRate}`);
