// Stage 9H-3I: 新規案件での3方式の比較の起動口（実API。承認制）。
//   node scripts/eval-9h3i.mjs preflight                                              ... 接続なし・費用なし。条件・累計・計画・推定費用を確認する
//   node scripts/eval-9h3i.mjs run --cases=<id,id> --approved-max-jpy=<円> [--per-case-jpy=<円>]  ... 実API（費用が発生）。承認された上限（100円以下）の範囲だけ
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const cmd = process.argv[2];
if (!existsSync("backups/eval-9h3i/plan.json")) {
  console.log("対象一覧が未確定です（backups/eval-9h3i/plan.json が無い）。先に本番から候補プールを書き出し、選定・凍結してください（docs/stage9h3i.md）");
  process.exit(cmd === "run" ? 1 : 0);
}
const plan = JSON.parse(readFileSync("backups/eval-9h3i/plan.json", "utf8"));
const ledger = existsSync("backups/eval-9h3i/ledger.json") ? JSON.parse(readFileSync("backups/eval-9h3i/ledger.json", "utf8")) : { spentJpy: 0 };
const cap = Number(arg("approved-max-jpy") ?? 0);
const perCase = Number(arg("per-case-jpy") ?? 12);
const cases = (arg("cases") ?? "").split(",").filter(Boolean);
const have = (k) => !!process.env[k]?.trim();
const n = plan.cases.length;
console.log(`計画: ${n}件（digest ${plan.digest}）／累計費用 ${Number(ledger.spentJpy).toFixed(2)}円／モデル ${plan.budget.model}`);
console.log(`推定費用（9H-3Fの実績: 12件で58.84円＝平均4.9円/件・最大6.6円/件。検索は1件あたり0〜3回）: 標準 ${(n * 5).toFixed(0)}円・上振れ ${(n * 7).toFixed(0)}円・上限（1件${perCase}円）${n * perCase}円`);
console.log(`条件: TOREMANE_ENV=${process.env.TOREMANE_ENV}／AGENT_REAL_API=${process.env.AGENT_REAL_API}／開発専用キー=${have("AGENT_ANTHROPIC_API_KEY") ? "設定あり" : "未設定"}`);
if (cmd !== "run") process.exit(0);
assertLocalTarget("eval-9h3i");
if (!(cap > 0) || cap > 100) throw new Error("--approved-max-jpy は 1〜100 の範囲で指定してください");
if (cases.length === 0) throw new Error("--cases が必要です");
if (Number(ledger.spentJpy) + 5 >= cap) throw new Error("累計費用が承認上限に近いため実行しません");
const r = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", "--testTimeout=3600000", "--hookTimeout=120000", "tests/eval9h3i.integration.test.ts"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, RUN_DB_TESTS: "1", E9H3I: "1", E9H3I_CASES: cases.join(","), E9H3I_REUSE: (arg("reuse") ?? ""), E9H3I_REDO: (arg("redo") ?? ""), E9H3I_CAP_JPY: String(cap), E9H3I_PER_CASE_JPY: String(perCase), E9H3I_CONFIRM: "yes" },
});
process.exit(r.status ?? 1);
