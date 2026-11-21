// Stage 10J の実行ラッパー（実AI・有料。上限: 90回・取得60・総額50円/1件3円）。**本番DBには接続しない**（入力はローカルの書き出しのみ）。
//   node scripts/refresh-10j.mjs run --confirm=yes        （環境変数 JUDGMENT_10J_ONLY=H3,H8 / JUDGMENT_10J_DEV=5,26 で一部のみ）
import { spawnSync } from "node:child_process";
import { assertLocalTarget } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 無ければ関門が止める */
}
if (process.env.NEXT_PUBLIC_SUPABASE_URL) assertLocalTarget("refresh-10j");
if (process.argv[2] !== "run" || !process.argv.includes("--confirm=yes")) {
  console.error("使い方: node scripts/refresh-10j.mjs run --confirm=yes");
  process.exit(2);
}
const key = process.env.AGENT_ANTHROPIC_API_KEY;
const pass = Object.fromEntries(["JUDGMENT_10J_ONLY", "JUDGMENT_10J_DEV"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const env = { ...process.env, ...pass, TOREMANE_ENV: "local", JUDGMENT_10J_RUN: "1", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REAL_CONFIRM: "yes", JUDGMENT_APPROVED_TOTAL_JPY: "50", JUDGMENT_APPROVED_PER_CASE_JPY: "3", JUDGMENT_REUSE_EXISTING_KEY: "allow", ...(key ? { JUDGMENT_REUSE_FALLBACK_KEY: key } : {}) };
const r = spawnSync("npx", ["vitest", "run", "src/lib/judgment/refresh-10j-real.test.ts", "--silent=false"], { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
