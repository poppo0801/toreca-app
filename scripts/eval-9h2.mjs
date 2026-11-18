// Stage 9H-2: 実AI×実Webの自律調査の検証の入口（開発専用。DBには接続しない）。
//   node scripts/eval-9h2.mjs preflight                                   接続なし。設定・事例集・累計の費用を確認する（費用なし）
//   node scripts/eval-9h2.mjs run --cases=<id,id> --approved-max-jpy=<円>  実API・実サイト（費用が発生）。累計が承認額（100円以下）を超える見込みなら呼ばずに止める
// 開発用の設定（.env.local）が必要: AGENT_REAL_API=allow・AGENT_ANTHROPIC_API_KEY（開発専用）・AGENT_MAX_COST_JPY_PER_RUN・AGENT_MAX_RUNS_PER_DAY。本番の設定では実行しない。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
assertLocalTarget("eval:9h2");
const [cmd, ...rest] = process.argv.slice(2);
const arg = (n) => rest.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

if (cmd === "preflight") {
  const has = (k) => (process.env[k] ?? "").trim() !== "";
  const cases = existsSync("backups/eval-9h2/cases.json") ? JSON.parse(readFileSync("backups/eval-9h2/cases.json", "utf8")).cases : [];
  const ledger = existsSync("backups/eval-9h2/ledger.json") ? JSON.parse(readFileSync("backups/eval-9h2/ledger.json", "utf8")) : null;
  console.log(JSON.stringify({ env: { TOREMANE_ENV: process.env.TOREMANE_ENV, AGENT_REAL_API: process.env.AGENT_REAL_API === "allow", devKeySet: has("AGENT_ANTHROPIC_API_KEY") }, model: process.env.AGENT_MODEL || "claude-haiku-5-5(既定)", cases: cases.length, byGroup: cases.reduce((m, c) => ((m[c.group] = (m[c.group] ?? 0) + 1), m), {}), spentSoFarJpy: ledger?.spentJpy ?? 0 }, null, 1));
  process.exit(0);
}
if (cmd !== "run") {
  console.error("使い方: node scripts/eval-9h2.mjs preflight | run --cases=<id,id> --approved-max-jpy=<円>");
  process.exit(2);
}
const cap = Number(arg("approved-max-jpy"));
if (!(cap > 0) || cap > 100) {
  console.error("承認された累計の費用の上限が必要です（100円以下）: --approved-max-jpy=<円>");
  process.exit(2);
}
if (!arg("cases")) {
  console.error("--cases=<id,id> が必要です");
  process.exit(2);
}
const env = { ...process.env, E9H2: "1", E9H2_CASES: arg("cases"), E9H2_CAP_JPY: String(cap), E9H2_CONFIRM: "yes" };
const r = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", "--testTimeout=1800000", "tests/eval9h2.integration.test.ts"], { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
