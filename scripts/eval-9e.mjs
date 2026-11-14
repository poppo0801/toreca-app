// Stage 9E: 自律調査の評価の入口（開発用ローカルDB・凍結した実在ページの再生）。
//   node scripts/eval-9e.mjs free [--scenarios=S01,S02] [--label=名前]                無料（固定の方針＋ルール抽出。API・外部通信なし）
//   node scripts/eval-9e.mjs real --approved-max-jpy=<円> [--scenarios=…] [--repeat=N] [--label=名前] [--system=ファイル]
//        実API（Claude Haiku 5.5・開発専用キー）。承認された累計の費用の上限（100円以下）の範囲だけ実行する。
//        累計は eval/runs/investigation-9e/ledger.json に記録され、実行をまたいで上限が守られる。
// 開発用の設定（.env.local）が必要: AGENT_REAL_API=allow・AGENT_ANTHROPIC_API_KEY・AGENT_MAX_COST_JPY_PER_RUN・AGENT_MAX_RUNS_PER_DAY。本番の設定では実行しない。
import { spawnSync } from "node:child_process";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
assertLocalTarget("eval:9e");
const [cmd, ...rest] = process.argv.slice(2);
const arg = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const env = { ...process.env, RUN_DB_TESTS: "1", E9E_LABEL: arg("label") ?? (cmd === "real" ? "real" : "free") };
if (arg("scenarios")) env.E9E_SCENARIOS = arg("scenarios");
if (arg("repeat")) env.E9E_REPEAT = arg("repeat");
if (arg("system")) env.E9E_SYSTEM_FILE = arg("system");
if (arg("reviews")) env.E9E_REVIEWS = arg("reviews");
if (rest.includes("--exec")) env.E9E_EXEC = "1";
if (rest.includes("--live")) env.E9E_LIVE = "1"; // 実際の公開サイトへ取得（robots尊重・間隔1.5秒・dry-run）
if (arg("brain")) env.E9E_BRAIN = arg("brain"); // fixed|real（切り分け）
if (arg("extract")) env.E9E_EXTRACT = arg("extract"); // rule|real（切り分け）

if (cmd === "real") {
  const cap = Number(arg("approved-max-jpy"));
  if (!(cap > 0) || cap > 100) {
    console.error("承認された累計の費用の上限が必要です（100円以下）: --approved-max-jpy=<円>（費用と条件を確認して、承認を得てから実行してください）");
    process.exit(2);
  }
  env.E9E_REAL = "1";
  env.E9E_CAP_JPY = String(cap);
  env.E9E_CONFIRM = "yes";
} else if (cmd !== "free") {
  console.error("使い方: node scripts/eval-9e.mjs free|real …");
  process.exit(2);
}
const r = spawnSync("npx", ["vitest", "run", "--no-file-parallelism", "--testTimeout=900000", "--hookTimeout=120000", "tests/eval9e.integration.test.ts"], { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
