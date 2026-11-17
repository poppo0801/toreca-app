// Stage 9H-3O: 系列横断調査の実AI検証の起動口（実API・費用が発生。承認された範囲だけ）。
//   node scripts/eval-9h3o.mjs preflight
//   node scripts/eval-9h3o.mjs run --cases=<id,id> --approved-max-jpy=<円> [--per-case-jpy=<円>]
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
if (!existsSync("backups/eval-9h3o/plan.json")) {
  console.log("対象が未確定です（backups/eval-9h3o/plan.json が無い）。scripts/freeze-9h3o-plan.mjs で凍結してください");
  process.exit(cmd === "run" ? 1 : 0);
}
const plan = JSON.parse(readFileSync("backups/eval-9h3o/plan.json", "utf8"));
const ledger = existsSync("backups/eval-9h3o/ledger.json") ? JSON.parse(readFileSync("backups/eval-9h3o/ledger.json", "utf8")) : { spentJpy: 0 };
const cap = Number(arg("approved-max-jpy") ?? 0);
const perCase = Number(arg("per-case-jpy") ?? 9);
const cases = (arg("cases") ?? "").split(",").filter(Boolean);
const have = (k) => !!process.env[k]?.trim();
console.log(`計画: ${plan.cases.length}件（digest ${plan.digest}）／累計費用 ${Number(ledger.spentJpy).toFixed(2)}円`);
console.log(`推定費用（9H-3Mの実績: 7件で46.52円＝平均6.6円/件）: 標準 ${(plan.cases.length * 6.6).toFixed(0)}円・上限（1件${perCase}円）${plan.cases.length * perCase}円`);
console.log(`条件: TOREMANE_ENV=${process.env.TOREMANE_ENV}／AGENT_REAL_API=${process.env.AGENT_REAL_API}／開発専用キー=${have("AGENT_ANTHROPIC_API_KEY") ? "設定あり" : "未設定"}`);
if (cmd !== "run") process.exit(0);
assertLocalTarget("eval-9h3o");
if (!(cap > 0) || cap > 100) throw new Error("--approved-max-jpy は 1〜100 の範囲で指定してください");
if (cases.length === 0) throw new Error("--cases が必要です");
if (Number(ledger.spentJpy) + perCase > cap) throw new Error("累計費用が承認上限に近いため実行しません");
const r = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", "--testTimeout=3600000", "tests/eval9h3o.sweep.test.ts"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, E9H3O_PLAN_FILE: arg("plan") ?? "plan.json", E9H3O: "1", E9H3O_CASES: cases.join(","), E9H3O_CAP_JPY: String(cap), E9H3O_PER_CASE_JPY: String(perCase), E9H3O_CONFIRM: "yes" },
});
process.exit(r.status ?? 1);
