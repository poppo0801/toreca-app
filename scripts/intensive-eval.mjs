// Phase 3 INTENSIVE_EVALUATION: 実案件の集中評価の起動入口（開発専用・ローカルDBのみ）。**承認が無ければ実AIを呼べない**。
//   node scripts/intensive-eval.mjs prepare --run=<名前> [--set=dev,unseen,regression|all] [--cases=id,id]   … ローカルDBへ（無課金）
//   node scripts/intensive-eval.mjs run --run=<名前> --approved-total-jpy=<円> --approved-per-case-jpy=<円> --confirm="APPROVE INTENSIVE <総額>JPY" [--judge=adaptive|haiku|sonnet] [--set=…] [--cases=…]
//   node scripts/intensive-eval.mjs score --run=<名前>[,<名前>…]   … 採点（gold.local.json と照合。無課金）
// 本番キーは使わない（開発用の既存キーをローカルでのみ再利用）。本番DB・本番の候補には接続しない。
import { spawnSync } from "node:child_process";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const cmd = process.argv[2];
const FILE = "src/lib/server/proposals/intensive-eval.real.test.ts";
try {
  process.loadEnvFile(".env.local");
} catch {
  /* 関門が止める */
}
const common = { TOREMANE_ENV: "local", JUDGMENT_INTENSIVE: "1", INTENSIVE_RUN: arg("run") ?? "", INTENSIVE_SET: arg("set") ?? "all", INTENSIVE_CASES: arg("cases") ?? "" };
const start = (extra) => {
  const r = spawnSync("npx", ["vitest", "run", "--silent=false", FILE], { stdio: "inherit", shell: true, env: { ...process.env, ...common, ...extra } });
  process.exit(r.status ?? 1);
};
if (cmd === "score") {
  const r = spawnSync("node", ["scripts/intensive-score.mjs", ...process.argv.slice(3)], { stdio: "inherit", shell: true });
  process.exit(r.status ?? 1);
}
if (!/^[a-z0-9-]{2,40}$/.test(common.INTENSIVE_RUN)) {
  console.error("--run=<英小文字・数字・ハイフン> が必要です");
  process.exit(2);
}
if (cmd === "prepare") start({ INTENSIVE_MODE: "prepare" });
if (cmd !== "run") {
  console.error("使い方: node scripts/intensive-eval.mjs prepare|run|score --run=…");
  process.exit(2);
}
const total = Number(arg("approved-total-jpy"));
const per = Number(arg("approved-per-case-jpy"));
const confirm = arg("confirm");
if (!(total > 0) || !(per > 0) || confirm !== `APPROVE INTENSIVE ${total}JPY`) {
  console.error(`承認額と確認文が必要です（--confirm="APPROVE INTENSIVE ${total || "<総額>"}JPY"）`);
  process.exit(2);
}
start({
  INTENSIVE_MODE: "run",
  INTENSIVE_JUDGE: arg("judge") ?? "adaptive",
  // PRODUCTION_PARITY: 調査モデル（--agent=haiku|sonnet）・推論の度合い（--agent-effort / --judge-effort = low|medium|high）の比較
  AGENT_MODEL: arg("agent") === "sonnet" ? "claude-sonnet-5-5" : "claude-haiku-5-5",
  INTENSIVE_AGENT_EFFORT: arg("agent-effort") ?? "",
  INTENSIVE_JUDGE_EFFORT: arg("judge-effort") ?? "",
  INTENSIVE_MAX_SEARCHES: arg("searches") ?? "",
  JUDGMENT_REAL_EVAL: "allow",
  JUDGMENT_REUSE_EXISTING_KEY: "allow",
  JUDGMENT_REUSE_FALLBACK_KEY: process.env.AGENT_ANTHROPIC_API_KEY ?? "",
  JUDGMENT_APPROVED_TOTAL_JPY: String(total),
  JUDGMENT_APPROVED_PER_CASE_JPY: String(per),
  JUDGMENT_REAL_CONFIRM: "yes",
  JUDGMENT_LIVE_FETCH: "allow",
});
