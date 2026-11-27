// EVIDENCE_UTILIZATION §5: 未知の情報元の自律探索の隔離実証の起動入口（開発専用・ローカルDBのみ・有料）。**承認が無ければ実AIを呼べない**。
//   node scripts/discovery-eval.mjs --run=<名前> --approved-total-jpy=<円> --approved-per-case-jpy=<円> --confirm="APPROVE DISCOVERY <総額>JPY" [--queries=6] [--max=20]
// 事前に `npm run prod -- scripts/eu-export-known.mjs --yes-production` で既知の情報元（eval/intensive/known.local.json）を書き出しておく。
import { spawnSync } from "node:child_process";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
try {
  process.loadEnvFile(".env.local");
} catch {
  /* 関門が止める */
}
const run = arg("run") ?? "";
const total = Number(arg("approved-total-jpy"));
const per = Number(arg("approved-per-case-jpy"));
if (!/^[a-z0-9-]{2,40}$/.test(run) || !(total > 0) || !(per > 0) || arg("confirm") !== `APPROVE DISCOVERY ${total}JPY`) {
  console.error(`使い方: --run=<名前> --approved-total-jpy=<円> --approved-per-case-jpy=<円> --confirm="APPROVE DISCOVERY ${total || "<総額>"}JPY"`);
  process.exit(2);
}
const r = spawnSync("npx", ["vitest", "run", "--silent=false", "src/lib/server/proposals/discovery-eval.real.test.ts"], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    TOREMANE_ENV: "local",
    DISCOVERY_EVAL: "1",
    DISCOVERY_RUN: run,
    DISCOVERY_QUERIES: arg("queries") ?? "",
    DISCOVERY_MAX_CANDIDATES: arg("max") ?? "",
    AGENT_MODEL: "claude-haiku-5-5",
    JUDGMENT_REAL_EVAL: "allow",
    JUDGMENT_REUSE_EXISTING_KEY: "allow",
    JUDGMENT_REUSE_FALLBACK_KEY: process.env.AGENT_ANTHROPIC_API_KEY ?? "",
    JUDGMENT_APPROVED_TOTAL_JPY: String(total),
    JUDGMENT_APPROVED_PER_CASE_JPY: String(per),
    JUDGMENT_REAL_CONFIRM: "yes",
    JUDGMENT_LIVE_FETCH: "allow",
  },
});
process.exit(r.status ?? 1);
