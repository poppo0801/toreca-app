// Stage 9H-3D: 実AIによる新旧方式の比較の起動口。
//   node scripts/eval-9h3d.mjs preflight                                    ... 接続なし・費用なし。条件・累計・計画を確認する
//   node scripts/eval-9h3d.mjs run --cases=<id,id> --approved-max-jpy=<円>  ... 実API（費用が発生）。承認された上限（100円以下）の範囲だけ
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
const plan = JSON.parse(readFileSync("backups/eval-9h3d/plan.json", "utf8"));
const ledger = existsSync("backups/eval-9h3d/ledger.json") ? JSON.parse(readFileSync("backups/eval-9h3d/ledger.json", "utf8")) : { spentJpy: 0 };
const cap = Number(arg("approved-max-jpy") ?? 0);
const cases = (arg("cases") ?? "").split(",").filter(Boolean);
const have = (k) => !!process.env[k]?.trim();
console.log(`計画: ${plan.cases.length}件（digest ${plan.digest}）／累計費用 ${Number(ledger.spentJpy).toFixed(2)}円／承認上限 ${plan.budget.totalJpy}円・1件${plan.budget.perCaseJpy}円／モデル ${plan.budget.model}`);
console.log(`条件: TOREMANE_ENV=${process.env.TOREMANE_ENV}／AGENT_REAL_API=${process.env.AGENT_REAL_API}／開発専用キー=${have("AGENT_ANTHROPIC_API_KEY") ? "設定あり" : "未設定"}`);
if (cmd !== "run") process.exit(0);
assertLocalTarget("eval-9h3d");
if (!(cap > 0) || cap > 100) throw new Error("--approved-max-jpy は 1〜100 の範囲で指定してください");
if (cases.length === 0) throw new Error("--cases が必要です");
if (Number(ledger.spentJpy) + 5 >= cap) throw new Error("累計費用が承認上限に近いため実行しません");
const r = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", "--testTimeout=3000000", "--hookTimeout=120000", "tests/eval9h3d.integration.test.ts"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, RUN_DB_TESTS: "1", E9H3D: "1", E9H3D_CASES: cases.join(","), E9H3D_CAP_JPY: String(cap), E9H3D_CONFIRM: "yes", E9H3D_VARIANT: arg("variant") ?? "B" },
});
process.exit(r.status ?? 1);
