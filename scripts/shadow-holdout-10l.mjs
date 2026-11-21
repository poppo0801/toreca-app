// Stage 10L: シャドーワーカーの実AIでの通し検証（ローカルDB・有料・上限: 総額50円/1件3円）。**本番には接続しない**。
//   node scripts/shadow-holdout-10l.mjs run --confirm=yes
import { spawnSync } from "node:child_process";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ関門が止める */
}
assertLocalTarget("shadow-holdout-10l");
if (process.argv[2] !== "run" || !process.argv.includes("--confirm=yes")) {
  console.error("使い方: node scripts/shadow-holdout-10l.mjs run --confirm=yes");
  process.exit(2);
}
const key = process.env.AGENT_ANTHROPIC_API_KEY;
const env = { ...process.env, RUN_DB_TESTS: "1", TOREMANE_ENV: "local", JUDGMENT_10L_HOLD: "1", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REAL_CONFIRM: "yes", JUDGMENT_APPROVED_TOTAL_JPY: "50", JUDGMENT_APPROVED_PER_CASE_JPY: "3", JUDGMENT_REUSE_EXISTING_KEY: "allow", ...(key ? { JUDGMENT_REUSE_FALLBACK_KEY: key } : {}) };
const r = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", "--testTimeout=3000000", "--hookTimeout=300000", "tests/stage10l-holdout-worker.integration.test.ts"], { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
