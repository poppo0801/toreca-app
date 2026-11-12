// 抽選グループ判定の実データ評価（Stage 8F-2）。実APIは費用が発生するため、承認された費用・実行回数の範囲だけ実行する。
//   node scripts/eval-grouping-real.mjs preflight [--repeats=N]           実行前の確認（API・ネットワークに接続しない。キーは表示しない）
//   node scripts/eval-grouping-real.mjs freeze                            評価データ（入力・正解）のハッシュを固定する（正解の確定後・実行前）
//   node scripts/eval-grouping-real.mjs run --approved-max-jpy=<円> --approved-runs=<回> [--repeats=N] [--followups=N]
//   node scripts/eval-grouping-real.mjs replay                            保存済みの提出を現在の検証層でやり直す（有料なし。新規の精度評価ではない）
// 事前に .env.local へ開発専用の設定が必要（AGENT_REAL_API=allow・AGENT_ANTHROPIC_API_KEY・AGENT_MAX_COST_JPY_PER_RUN・AGENT_MAX_RUNS_PER_DAY）。
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
const base = { ...process.env, ...(arg("repeats") ? { REAL_GROUPING_REPEATS: arg("repeats") } : {}) };
const vitest = (name, extra) => spawnSync("npx", ["vitest", "run", "src/lib/agent/lottery-grouping/real-eval.test.ts", "-t", name], { stdio: "inherit", shell: true, env: { ...base, ...extra } });

if (cmd === "preflight") {
  const r = vitest("実行前の確認", { REAL_GROUPING_PREFLIGHT: "1" });
  if (r.status === 0) console.log(readFileSync("eval/runs/lottery-grouping-real/preflight.json", "utf8"));
  process.exit(r.status ?? 1);
} else if (cmd === "freeze") {
  process.exit(vitest("評価データの凍結", { REAL_GROUPING_FREEZE: "1" }).status ?? 1);
} else if (cmd === "replay") {
  process.exit(vitest("保存済みの提出の再判定", { REAL_GROUPING_REPLAY: "1" }).status ?? 1);
} else if (cmd === "run") {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) assertLocalTarget("eval:grouping-real");
  const max = Number(arg("approved-max-jpy"));
  const runs = Number(arg("approved-runs"));
  if (!(max > 0) || !(runs > 0)) {
    console.error("承認された費用の上限と実行回数が必要です: --approved-max-jpy=<円> --approved-runs=<回>（費用と条件を確認して、承認を得てから実行してください）");
    process.exit(2);
  }
  process.exit(vitest("実API評価", { REAL_GROUPING_EVAL: "1", REAL_GROUPING_APPROVED_MAX_JPY: String(max), REAL_GROUPING_APPROVED_RUNS: String(runs), REAL_GROUPING_FOLLOWUPS: arg("followups") ?? "1" }).status ?? 1);
} else {
  console.error("使い方: node scripts/eval-grouping-real.mjs preflight | freeze | replay | run --approved-max-jpy=<円> --approved-runs=<回> [--repeats=N] [--followups=N]");
  process.exit(1);
}
