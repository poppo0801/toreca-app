// Stage 10I の実行ラッパー（実AI・有料。上限: 30件・90回・総額50円/1件3円）。**本番DBには接続しない**（入力はR0のローカルファイル）。
//   node scripts/refresh-10i.mjs run --confirm=yes
import { spawnSync } from "node:child_process";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ関門が止める */
}
if (process.env.NEXT_PUBLIC_SUPABASE_URL) assertLocalTarget("refresh-10i");
if (process.argv[2] !== "run" || !process.argv.includes("--confirm=yes")) {
  console.error("使い方: node scripts/refresh-10i.mjs run --confirm=yes");
  process.exit(2);
}
const key = process.env.AGENT_ANTHROPIC_API_KEY;
const env = { ...process.env, TOREMANE_ENV: "local", JUDGMENT_10I_RUN: "1", ...(process.env.JUDGMENT_10I_MODES ? { JUDGMENT_10I_MODES: process.env.JUDGMENT_10I_MODES } : {}), ...(process.env.JUDGMENT_10I_ONLY ? { JUDGMENT_10I_ONLY: process.env.JUDGMENT_10I_ONLY } : {}), JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REAL_CONFIRM: "yes", JUDGMENT_APPROVED_TOTAL_JPY: "50", JUDGMENT_APPROVED_PER_CASE_JPY: "3", JUDGMENT_REUSE_EXISTING_KEY: "allow", ...(key ? { JUDGMENT_REUSE_FALLBACK_KEY: key } : {}) };
const r = spawnSync("npx", ["vitest", "run", "src/lib/judgment/refresh-10i-real.test.ts", "--silent=false"], { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
