// Stage 9H-3R: 自律探索の実AI・実Web検証の起動口（実API・費用が発生。承認された範囲＝今回の検証全体で100円以内）。
//   node scripts/eval-9h3r.mjs preflight          （接続なし・費用0。ミッションの準備状況と累計費用）
//   node scripts/eval-9h3r.mjs run --missions=0,1 --approved-max-jpy=<円> [--per-mission-jpy=<円>]
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
const ledger = existsSync("backups/eval-9h3r/ledger.json") ? JSON.parse(readFileSync("backups/eval-9h3r/ledger.json", "utf8")) : { spentJpy: 0 };
const cap = Number(arg("approved-max-jpy") ?? 0);
const per = Number(arg("per-mission-jpy") ?? 10);
const missions = (arg("missions") ?? "").split(",").filter(Boolean);
console.log(`累計費用（9H-3R）: ${Number(ledger.spentJpy).toFixed(2)}円／今回の検証の上限 100円`);
console.log(`条件: TOREMANE_ENV=${process.env.TOREMANE_ENV}／AGENT_REAL_API=${process.env.AGENT_REAL_API}／開発専用キー=${process.env.AGENT_ANTHROPIC_API_KEY?.trim() ? "設定あり" : "未設定"}`);
if (cmd !== "run") process.exit(0);
assertLocalTarget("eval-9h3r");
if (!(cap > 0) || cap > 100) throw new Error("--approved-max-jpy は 1〜100 の範囲で指定してください");
if (missions.length === 0) throw new Error("--missions が必要です");
if (Number(ledger.spentJpy) + per > cap) throw new Error("累計費用が承認上限に近いため実行しません");
const r = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", "--testTimeout=3600000", "tests/eval9h3r.real.test.ts"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, E9H3R: "1", E9H3R_MISSIONS: missions.join(","), E9H3R_CAP_JPY: String(cap), E9H3R_PER_MISSION_JPY: String(per), E9H3R_CONFIRM: "yes", E9H3R_TIME_MS: arg("time-ms") ?? "120000" },
});
process.exit(r.status ?? 1);
