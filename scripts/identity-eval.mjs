// JUDGMENT_IDENTITY_EFFICIENCY §2: 同一性の隔離評価の起動（開発専用）。
//   検索だけ（無課金）: node scripts/identity-eval.mjs run --run=<名前> --dry
//   実AI（有料）:       node scripts/identity-eval.mjs run --run=<名前> --approved-total-jpy=<円> --approved-per-case-jpy=<円> --confirm="APPROVE IDENTITY <円>JPY" [--effort=low|medium|high] [--thinking=off] [--model=sonnet] [--cases=a,b]
//   採点:               node scripts/identity-score.mjs --run=<名前>
import { spawnSync } from "node:child_process";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const has = (n) => process.argv.includes(`--${n}`);
try {
  process.loadEnvFile(".env.local");
} catch {
  /* 関門が止める */
}
const run = arg("run") ?? "";
if (process.argv[2] !== "run" || !/^[a-z0-9-]{2,40}$/.test(run)) {
  console.error("使い方: node scripts/identity-eval.mjs run --run=<名前> [--dry | --approved-total-jpy=… --approved-per-case-jpy=… --confirm=…]");
  process.exit(2);
}
const dry = has("dry");
const total = Number(arg("approved-total-jpy"));
const per = Number(arg("approved-per-case-jpy"));
if (!dry && (!(total > 0) || !(per > 0) || arg("confirm") !== `APPROVE IDENTITY ${total}JPY`)) {
  console.error(`承認額と確認文が必要です（--confirm="APPROVE IDENTITY ${total || "<総額>"}JPY"）`);
  process.exit(2);
}
const r = spawnSync("npx", ["vitest", "run", "--silent=false", "src/lib/server/proposals/identity-eval.real.test.ts"], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    TOREMANE_ENV: "local",
    JUDGMENT_IDENTITY_EVAL: "1",
    IDENTITY_RUN: run,
    IDENTITY_DRY: dry ? "1" : "",
    IDENTITY_CASES: arg("cases") ?? "",
    IDENTITY_EFFORT: arg("effort") ?? "",
    IDENTITY_THINKING: arg("thinking") ?? "",
    IDENTITY_MODEL: arg("model") ?? "",
    ...(dry
      ? {}
      : { JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REUSE_EXISTING_KEY: "allow", JUDGMENT_REUSE_FALLBACK_KEY: process.env.AGENT_ANTHROPIC_API_KEY ?? "", JUDGMENT_APPROVED_TOTAL_JPY: String(total), JUDGMENT_APPROVED_PER_CASE_JPY: String(per), JUDGMENT_REAL_CONFIRM: "yes" }),
  },
});
process.exit(r.status ?? 1);
