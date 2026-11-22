// Stage 10R: 人の訂正を、理由つきでヒントストアに記録する（ローカルのデータファイルへの追記だけ）。
//   node scripts/knowledge-correct.mjs --id K-PLATFORM-LP-MULTI --by あなたの名前 --action add_exception --reason "理由" --detail "反例・例外の内容"
//   action: add_exception（当てはまらない条件の追記）／add_counterexample（反例の追記）／invalidate（無効化）
// ユーザーが明示的に実行したときだけ書く。AI・自動処理の名義は拒否。理由が必須。AIの未確認の判断を事例として追加する経路は無い。
// 人の訂正も絶対ルールにはならない（AIに観点・例外・反例として渡るだけ。src/lib/judgment/xsource/knowledge/knowledge.ts の effectiveEntries）。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src/lib/judgment/xsource/knowledge/apply-unit-knowledge.json";
const AI_NAME = /(^|[^a-z])(ai|claude|haiku|gpt|llm|bot|auto)([^a-z]|$)/i;
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? "") : "";
};
const id = arg("id");
const by = arg("by").trim();
const action = arg("action");
const reason = arg("reason").trim();
const detail = arg("detail").trim();
const fail = (m) => {
  console.error(m);
  process.exit(2);
};
if (!id || !by || !action || !reason) fail("使い方: --id <知識ID> --by <あなたの名前> --action add_exception|add_counterexample|invalidate --reason <理由> [--detail <内容>]");
if (AI_NAME.test(by)) fail("訂正者の名前が不正です（AI・自動処理の名義は不可）");
if (!["add_exception", "add_counterexample", "invalidate"].includes(action)) fail("action が不正です");
if (action !== "invalidate" && !detail) fail("--detail（追記する内容）が必要です");
const data = JSON.parse(readFileSync(FILE, "utf8"));
if (!data.entries.some((e) => e.id === id)) fail("知識IDが見つかりません");
data.corrections = [...(data.corrections ?? []), { knowledgeId: id, reason, by, at: new Date().toISOString().slice(0, 10), action, detail }];
writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n");
console.log(`訂正を記録しました（${id}・${action}）。ヒントは参考の観点として渡されるだけで、絶対ルールにはなりません。`);
