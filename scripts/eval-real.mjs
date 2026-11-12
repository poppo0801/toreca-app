// 実在店舗の評価（Stage 8D-3）。実APIは費用が発生するため、承認された件数・費用の範囲だけ実行する。
//   node scripts/eval-real.mjs preflight [--ids=R1,R2]                         実行前の確認（API・ネットワークに接続しない。キーは表示しない）
//   node scripts/eval-real.mjs run --approved-max-jpy=<円> --approved-stores=<件> [--ids=R1,...] [--first-only]
//   run には --phase=initial|rerun（初回/再実行。集計を分ける）・--continue（誤住所があっても続ける。API障害などでは必ず止まる）が使える。
// 事前に .env.local へ開発専用の設定が必要（AGENT_REAL_API=allow・AGENT_ANTHROPIC_API_KEY・AGENT_MAX_COST_JPY_PER_RUN・AGENT_MAX_RUNS_PER_DAY。docs/stage8d3.md §5）。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ関門が止める */
}
const [cmd, ...rest] = process.argv.slice(2);
const arg = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const env = { ...process.env, ...(arg("ids") ? { REAL_EVAL_IDS: arg("ids") } : {}) };

if (cmd === "preflight") {
  const r = spawnSync("npx", ["vitest", "run", "src/lib/agent/store-location/real-eval.test.ts", "-t", "実行前の確認"], { stdio: "inherit", shell: true, env: { ...env, REAL_PREFLIGHT: "1" } });
  if (r.status === 0) console.log(readFileSync("eval/runs/real/preflight.json", "utf8"));
  process.exit(r.status ?? 1);
} else if (cmd === "report") {
  // 集計（API・ネットワークには接続しない）: 初回(initial)と再実行(rerun)を別に集計して eval/runs/real/summary-8d4-*.json に書く
  const r = spawnSync("npx", ["vitest", "run", "src/lib/agent/store-location/real-eval.test.ts", "-t", "集計の出力"], { stdio: "inherit", shell: true, env: { ...env, REAL_REPORT: "1" } });
  process.exit(r.status ?? 1);
} else if (cmd === "replay") {
  // 保存済みデータでの再検証（有料API・検索なし。国土地理院の住所検索だけ使う）: 実行記録のAIの提出と取得済みページを、現在の検証層でやり直す
  const r = spawnSync("npx", ["vitest", "run", "src/lib/agent/store-location/real-eval.test.ts", "-t", "保存済みデータでの再検証"], { stdio: "inherit", shell: true, env: { ...env, REAL_REPLAY: "1" } });
  process.exit(r.status ?? 1);
} else if (cmd === "run") {
  // 開発用ローカルの設定であることを確認（本番の設定では実行しない）
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) assertLocalTarget("eval:real");
  const max = Number(arg("approved-max-jpy"));
  const stores = Number(arg("approved-stores"));
  if (!(max > 0) || !(stores > 0)) {
    console.error("承認された費用の上限と件数が必要です: --approved-max-jpy=<円> --approved-stores=<件>（費用と条件を確認して、承認を得てから実行してください）");
    process.exit(2);
  }
  const r = spawnSync("npx", ["vitest", "run", "src/lib/agent/store-location/real-eval.test.ts", "-t", "実API評価"], {
    stdio: "inherit",
    shell: true,
    env: { ...env, REAL_EVAL: "1", REAL_EVAL_APPROVED_MAX_JPY: String(max), REAL_EVAL_APPROVED_STORES: String(stores), ...(rest.includes("--first-only") ? { REAL_EVAL_FIRST_ONLY: "1" } : {}), REAL_EVAL_PHASE: arg("phase") === "rerun" ? "rerun" : "initial", ...(rest.includes("--continue") ? { REAL_EVAL_CONTINUE: "1" } : {}) },
  });
  process.exit(r.status ?? 1);
} else {
  console.error("使い方: node scripts/eval-real.mjs preflight | report | replay | run --approved-max-jpy=<円> --approved-stores=<件> [--ids=R1,..] [--first-only]");
  process.exit(1);
}
